"""Tests for the pairing between a desktop app and a Beacon server: the
server's side (core/device_keys.py, routes/device_link.py) and the desktop's
(core/server_link.py, routes/server_link.py and the routes it hooks into)."""

import asyncio
import json
import os
import sqlite3
import stat
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import HTTPException, Response
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

from core import (
    account_settings,
    api_keys,
    device_keys,
    lyrics_offsets,
    media_login,
    now_playing,
    play_history,
    server_link,
)
from core import session as session_module
from core.claims import claims
from core.play_history import Account
from core.remote import remote
from core.session import SessionState
from core.state import TEST_TONE_TRACK_ID
from main import app
from media import JellyfinClient, PlexClient, SubsonicClient
from media.base import Track
from media.login_errors import SubsonicError
from routes import device_link, playback, player_desktop, player_server, stream

# Before the autouse fixture in conftest.py stands in for it.
real_run = server_link.run

ALICE = Account("subsonic", "srv-id", "alice")
BOB = Account("subsonic", "srv-id", "bob")
ALICE_SETTINGS = ("subsonic", "https://music.example", "alice")
URL = "https://beacon.example"
NOW = 1_800_000_000
DAY = 86_400


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    play_history._last_recorded.clear()
    device_link.limiter.clear()
    now_playing._reports.clear()
    api_keys._cache.clear()
    monkeypatch.delenv("LASTFM_API_KEY", raising=False)
    monkeypatch.delenv("FANART_API_KEY", raising=False)
    with (
        patch.object(api_keys, "_DATA_DIR", str(tmp_path / "keys")),
        patch.object(play_history, "_DIR", str(tmp_path / "history")),
        patch.object(account_settings, "_PATH", str(tmp_path / "settings.json")),
    ):
        yield


@pytest.fixture
def signed_in(default_session):
    default_session.account_server_type = ALICE.server_type
    default_session.account_server_url = ALICE.server_url
    default_session.account_username = ALICE.username
    default_session.settings_identity = ALICE_SETTINGS
    return default_session


@pytest.fixture
def on_server(signed_in, monkeypatch):
    """Signed in on a Docker server rather than in a desktop app."""
    monkeypatch.setattr(server_link, "AVAILABLE", False)
    return signed_in


@pytest.fixture
def public():
    """No CONNECT_TOKEN and no session: what a desktop arrives with."""
    with TestClient(app) as c:
        yield c


def key_for(account=ALICE, identity=ALICE_SETTINGS) -> str:
    return device_keys.create(account, "Laptop", identity)["key"]


def auth(key: str) -> dict:
    return {server_link.KEY_HEADER: key}


def row(id_: str = "a" * 32, ts: int = NOW, song_id: str = "s1", **over) -> dict:
    return {"id": id_, "ts": ts, "song_id": song_id, "title": "T", "artist": "A", **over}


def own_timestamps(account=ALICE) -> list[int]:
    return play_history.summary(account, now=NOW)["timestamps"]


# ── migration ────────────────────────────────────────────────────────────


def test_an_existing_log_survives_the_upgrade(tmp_path):
    os.makedirs(play_history._DIR)
    conn = sqlite3.connect(os.path.join(play_history._DIR, play_history._DATABASE))
    for statement in play_history._SCHEMA:
        conn.execute(statement)
    conn.execute("INSERT INTO accounts (server_type, server_url, username) VALUES (?, ?, ?)", ALICE)
    conn.execute(
        "INSERT INTO listens (id, account_id, ts, source, song_id, title) VALUES"
        " ('x', 1, ?, 'beacon', 's1', 'Old')",
        (NOW,),
    )
    conn.execute("PRAGMA user_version = 1")
    conn.commit()
    conn.close()

    assert own_timestamps() == [NOW]
    assert [r["id"] for r in play_history.unsent_listens(ALICE, 10)] == ["x"]
    conn = sqlite3.connect(os.path.join(play_history._DIR, play_history._DATABASE))
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(play_history._MIGRATIONS)
    conn.close()


def test_a_new_database_has_every_table():
    assert device_keys.list_keys(ALICE) == []
    assert play_history.count_unsent(ALICE) == 0


# ── keys ─────────────────────────────────────────────────────────────────


def test_a_key_names_its_account():
    owner = device_keys.resolve(key_for())
    assert owner.account == ALICE
    assert owner.settings_identity == ALICE_SETTINGS


def test_a_wrong_secret_is_refused():
    key_id = key_for().split(".")[0]
    assert device_keys.resolve(f"{key_id}.nope") is None
    assert device_keys.resolve("no-such-key") is None
    assert device_keys.resolve("") is None


def test_only_the_hash_is_stored():
    secret = key_for().split(".")[1]
    with play_history.transaction() as conn:
        stored = conn.execute("SELECT * FROM device_keys").fetchone()
    assert all(secret not in str(value) for value in tuple(stored))


def test_a_revoked_key_stops_working():
    created = device_keys.create(ALICE, "Laptop", None)
    assert device_keys.revoke(ALICE, created["id"])
    assert device_keys.resolve(created["key"]) is None


def test_nobody_can_revoke_another_accounts_key():
    created = device_keys.create(ALICE, "Laptop", None)
    assert not device_keys.revoke(BOB, created["id"])
    assert device_keys.resolve(created["key"]) is not None


def test_keys_per_account_are_bounded():
    for _ in range(device_keys.MAX_KEYS_PER_ACCOUNT):
        device_keys.create(ALICE, "x", None)
    with pytest.raises(device_keys.TooManyKeys):
        device_keys.create(ALICE, "x", None)
    device_keys.create(BOB, "x", None)


def test_last_used_is_recorded_and_not_written_on_every_request():
    created = device_keys.create(ALICE, "Laptop", None, now=NOW)
    device_keys.resolve(created["key"], now=NOW + 100)
    device_keys.resolve(created["key"], now=NOW + 110)
    assert device_keys.list_keys(ALICE)[0]["last_used_at"] == NOW + 100


def test_a_key_counts_as_active_only_while_its_device_checks_in():
    created = device_keys.create(ALICE, "Laptop", None, now=NOW)
    assert device_keys.list_keys(ALICE, now=NOW)[0]["active"] is False
    device_keys.resolve(created["key"], now=NOW)
    quiet_for = device_keys.ACTIVE_WITHIN_SECONDS
    assert device_keys.list_keys(ALICE, now=NOW + quiet_for - 1)[0]["active"] is True
    assert device_keys.list_keys(ALICE, now=NOW + quiet_for)[0]["active"] is False


def test_settings_identity_needs_the_verified_name(signed_in):
    signed_in.settings_identity = ("subsonic", "https://music.example", "ALICE")
    assert device_keys.settings_identity_of(signed_in) is not None
    signed_in.settings_identity = ("subsonic", "https://music.example", "bob")
    assert device_keys.settings_identity_of(signed_in) is None


def test_keys_are_made_for_the_signed_in_account(client, on_server):
    made = client.post("/device-keys", json={"label": "Laptop", "scopes": ["sync"]}).json()
    assert device_keys.resolve(made["key"]).account == ALICE
    assert device_keys.resolve(made["key"]).settings_identity == ALICE_SETTINGS


def test_the_list_never_contains_a_key(client, on_server):
    made = client.post("/device-keys", json={"label": "Laptop", "scopes": ["sync"]}).json()
    text = client.get("/device-keys").text
    assert made["key"] not in text
    assert made["key"].split(".")[1] not in text
    assert "key_hash" not in text


def test_making_a_key_needs_a_session(client):
    assert client.post("/device-keys", json={"label": "x"}).status_code == 401


def test_a_key_can_be_revoked_over_http(client, on_server):
    made = client.post("/device-keys", json={"label": "Laptop", "scopes": ["sync"]}).json()
    assert client.delete(f"/device-keys/{made['id']}").status_code == 200
    assert client.delete(f"/device-keys/{made['id']}").status_code == 404


# ── the server's public routes ───────────────────────────────────────────


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/device-link/info"),
        ("GET", "/device-link/summary"),
        ("GET", "/device-link/charts"),
        ("GET", "/device-link/settings"),
        ("POST", "/device-link/listens"),
        ("PUT", "/device-link/milestones"),
        ("PATCH", "/device-link/settings"),
    ],
)
def test_every_route_needs_a_key(public, method, path):
    assert public.request(method, path).status_code == 401
    assert public.request(method, path, headers=auth("bad.key")).status_code == 401


def test_a_key_alone_is_enough(public):
    response = public.get("/device-link/info", headers=auth(key_for()))
    assert response.json() == {"device_link": 1, "username": "alice", "scopes": ["sync"]}


def test_repeated_wrong_keys_are_slowed_down(public):
    limit = device_link._KEY_FAILURES_PER_IP[0]
    for _ in range(limit):
        assert public.get("/device-link/info", headers=auth("x.y")).status_code == 401
    refused = public.get("/device-link/info", headers=auth("x.y"))
    assert refused.status_code == 429
    assert int(refused.headers["retry-after"]) > 0
    # A correct key is refused too while locked: checking it would be the
    # lookup the limit is there to prevent.
    assert public.get("/device-link/info", headers=auth(key_for())).status_code == 429


def test_listens_land_on_the_keys_account_only(public):
    with patch("time.time", return_value=NOW):
        response = public.post(
            "/device-link/listens", headers=auth(key_for()), json={"listens": [row()]}
        )
    assert response.json() == {"stored": 1}
    assert own_timestamps(ALICE) == [NOW]
    assert own_timestamps(BOB) == []


@pytest.mark.parametrize(
    ("apart", "stored"),
    [(0, 0), (59, 0), (-59, 0), (60, 1), (-60, 1)],
)
def test_a_play_only_counts_as_the_same_within_a_minute(apart, stored):
    first = {"id": "a" * 32, "ts": NOW, "song_id": "s1"}
    second = {"id": "b" * 32, "ts": NOW + apart, "song_id": "s1"}
    play_history.receive_listens(ALICE, [first], now=NOW)
    assert play_history.receive_listens(ALICE, [second], now=NOW) == stored


def test_a_label_of_only_spaces_is_refused(client, on_server):
    made = client.post("/device-keys", json={"label": "   ", "scopes": ["sync"]})
    assert made.status_code == 422


def test_a_label_is_stored_without_the_spaces_around_it(client, on_server):
    client.post("/device-keys", json={"label": "  Laptop ", "scopes": ["sync"]})
    assert client.get("/device-keys").json()["keys"][0]["label"] == "Laptop"


def test_sending_the_same_play_twice_changes_nothing(public):
    key = key_for()
    body = {"listens": [row()]}
    with patch("time.time", return_value=NOW):
        public.post("/device-link/listens", headers=auth(key), json=body)
        second = public.post("/device-link/listens", headers=auth(key), json=body)
    assert second.json() == {"stored": 0}
    assert own_timestamps() == [NOW]


def test_a_batch_has_a_limit(public):
    rows = [row(id_=f"{i:032x}", ts=NOW - i * 100) for i in range(device_link._MAX_BATCH + 1)]
    response = public.post("/device-link/listens", headers=auth(key_for()), json={"listens": rows})
    assert response.status_code == 422
    assert own_timestamps() == []


def test_a_malformed_id_is_refused(public):
    response = public.post(
        "/device-link/listens", headers=auth(key_for()), json={"listens": [row(id_="short")]}
    )
    assert response.status_code == 422


def test_an_oversized_body_is_refused(public):
    with patch.object(device_link, "_MAX_LISTENS_BODY", 100):
        response = public.post(
            "/device-link/listens", headers=auth(key_for()), json={"listens": [row()]}
        )
    assert response.status_code == 413


def test_a_play_from_the_far_future_is_dropped():
    stored = play_history.receive_listens(ALICE, [row(ts=NOW + 2 * DAY)], now=NOW)
    assert stored == 0
    assert own_timestamps() == []


def test_a_slightly_fast_clock_is_kept():
    assert play_history.receive_listens(ALICE, [row(ts=NOW + 3600)], now=NOW) == 1


def test_one_play_reported_through_two_paths_counts_once():
    assert play_history.receive_listens(ALICE, [row(id_="a" * 32, ts=NOW)], now=NOW) == 1
    assert play_history.receive_listens(ALICE, [row(id_="b" * 32, ts=NOW + 30)], now=NOW) == 0
    assert play_history.receive_listens(ALICE, [row(id_="c" * 32, ts=NOW + 300)], now=NOW) == 1


def test_older_own_plays_cut_an_import_back():
    play_history.replace_imported(
        ALICE,
        "lastfm",
        [{"ts": NOW - 300, "title": "x", "artist": "a"}, {"ts": NOW - 50, "title": "y"}],
    )
    play_history.receive_listens(ALICE, [row(ts=NOW - 100)], now=NOW)
    assert own_timestamps() == [NOW - 300, NOW - 100]


def test_a_batch_that_does_not_move_the_first_play_leaves_the_import():
    play_history.receive_listens(ALICE, [row(ts=NOW - 100)], now=NOW)
    play_history.replace_imported(ALICE, "lastfm", [{"ts": NOW - 300, "title": "x"}])
    play_history.receive_listens(ALICE, [row(id_="b" * 32, ts=NOW, song_id="s2")], now=NOW)
    assert own_timestamps() == [NOW - 300, NOW - 100, NOW]


def test_a_backfill_is_not_a_moment():
    play_history.save_milestones(ALICE, {"plays": 5})
    play_history.receive_listens(ALICE, [row()], backfill=True, now=NOW)
    assert play_history.milestones(ALICE) is None


def test_an_ordinary_batch_keeps_the_milestones():
    play_history.save_milestones(ALICE, {"plays": 5})
    play_history.receive_listens(ALICE, [row()], now=NOW)
    assert play_history.milestones(ALICE) == {"plays": 5}


def test_a_backfill_that_brought_nothing_new_keeps_them():
    play_history.receive_listens(ALICE, [row()], now=NOW)
    play_history.save_milestones(ALICE, {"plays": 5})
    play_history.receive_listens(ALICE, [row()], backfill=True, now=NOW)
    assert play_history.milestones(ALICE) == {"plays": 5}


def test_milestones_only_merge_upwards(public):
    key = key_for()
    play_history.save_milestones(ALICE, {"plays": 9, "hours": 1, "streak": 1, "records": 0})
    body = {"plays": 2, "hours": 3, "streak": 1, "records": 0}
    public.put("/device-link/milestones", headers=auth(key), json=body)
    assert play_history.milestones(ALICE)["plays"] == 9
    assert play_history.milestones(ALICE)["hours"] == 3


def test_summary_is_the_keys_account(public):
    play_history.receive_listens(BOB, [row(id_="b" * 32)], now=NOW)
    answer = public.get("/device-link/summary", headers=auth(key_for())).json()
    assert answer["total"] == 0
    assert answer["milestones"] is None


def test_charts_are_the_keys_account_over_the_chosen_window(public):
    now = int(time.time())
    play_history.receive_listens(
        ALICE,
        [row(id_="a" * 32, ts=now - 2 * DAY), row(id_="b" * 32, ts=now - 40 * DAY)],
        now=now,
    )
    key = key_for()
    week = public.get("/device-link/charts?period=week", headers=auth(key)).json()
    assert week["period"] == "week"
    assert week["total"] == 1
    assert public.get("/device-link/charts", headers=auth(key)).json()["total"] == 2
    play_history.receive_listens(BOB, [row(id_="c" * 32, ts=now)], now=now)
    assert public.get("/device-link/charts", headers=auth(key)).json()["total"] == 2


def test_a_nonsense_chart_window_is_refused(public):
    response = public.get("/device-link/charts?period=decade", headers=auth(key_for()))
    assert response.status_code == 422


def test_settings_only_carry_the_shared_fields(public):
    key = key_for()
    public.patch(
        "/device-link/settings",
        headers=auth(key),
        json={"settings": {"locale": "de", "releaseNotesSeen": "9.9", "fromTheFuture": 1}},
    )
    stored = account_settings.load(*ALICE_SETTINGS)
    assert stored == {"locale": "de"}


def test_reading_settings_leaves_out_what_is_not_shared(public):
    account_settings.save(*ALICE_SETTINGS, {"locale": "de", "releaseNotesSeen": "1.0"})
    answer = public.get("/device-link/settings", headers=auth(key_for())).json()
    assert answer == {"locale": "de"}


def test_settings_have_a_size_limit(public):
    body = {"settings": {"locale": "x" * (device_link._MAX_SETTINGS_BODY + 1)}}
    response = public.patch("/device-link/settings", headers=auth(key_for()), json=body)
    assert response.status_code == 413
    assert account_settings.load(*ALICE_SETTINGS) == {}


def test_a_key_without_a_settings_identity_touches_no_settings(public):
    account_settings.save(*ALICE_SETTINGS, {"locale": "de"})
    key = key_for(identity=None)
    assert public.get("/device-link/settings", headers=auth(key)).json() == {}
    public.patch("/device-link/settings", headers=auth(key), json={"settings": {"locale": "fr"}})
    assert account_settings.load(*ALICE_SETTINGS) == {"locale": "de"}


# ── the desktop's side ───────────────────────────────────────────────────


class FakeServer:
    """A paired Beacon server, answering what each test tells it to."""

    def __init__(self):
        self.reported: list = []
        self.wants_now_playing = True
        self.scopes = ["sync"]
        self.requests: list[httpx.Request] = []
        self.settings: dict = {}
        self.offsets: dict = {}
        self.api_keys: dict = {}
        self.summary: dict = {
            "available": True,
            "total": 1,
            "timestamps": [NOW - 100],
            "live_since": NOW - 100,
            "recent_plays": {"s9": 1},
            "top": {"songs": [], "artists": [], "albums": [], "genres": []},
            "milestones": {"plays": 3},
        }
        self.charts: dict = {
            "period": "all_time",
            "total": 1,
            "top": {"songs": [], "artists": [], "albums": [], "genres": []},
        }
        # Spelled differently from ALICE on purpose: the same person to a
        # server that does not care about case.
        self.username = "Alice"
        self.fail: httpx.Response | Exception | None = None
        self.on_request = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.on_request:
            self.on_request(request)
        if isinstance(self.fail, Exception):
            raise self.fail
        if self.fail is not None:
            return self.fail
        path = request.url.path.removeprefix("/device-link")
        if path == "/now-playing":
            body = json.loads(request.content) if request.method == "PUT" else None
            self.reported.append(body)
            return httpx.Response(200, json={"wanted": self.wants_now_playing})
        if path == "/info":
            return httpx.Response(
                200, json={"device_link": 1, "username": self.username, "scopes": self.scopes}
            )
        if path == "/settings" and request.method == "GET":
            return httpx.Response(200, json=self.settings)
        if path == "/summary":
            return httpx.Response(200, json=self.summary)
        if path == "/charts":
            return httpx.Response(200, json=self.charts)
        if path == "/api-keys":
            return httpx.Response(200, json={"keys": self.api_keys})
        if path == "/lyrics-offsets" and request.method == "GET":
            return httpx.Response(200, json={"offsets": self.offsets})
        return httpx.Response(200, json={"status": "ok"})

    def sent(self, method: str, path: str) -> list[dict]:
        return [
            json.loads(r.content)
            for r in self.requests
            if r.method == method and r.url.path == f"/device-link{path}"
        ]


@pytest.fixture
def server(monkeypatch):
    fake = FakeServer()
    monkeypatch.setattr(server_link, "_transport", httpx.MockTransport(fake))
    return fake


@pytest.fixture
def paired(server):
    server_link.pair(ALICE, ALICE_SETTINGS, URL, "the-key")
    server.requests.clear()
    server_link.send_once()
    server.requests.clear()
    return server


def play(account=ALICE, song_id="s1", now=NOW) -> None:
    play_history.record(account, {"song_id": song_id, "title": "T", "artist": "A"}, now=now)
    play_history._last_recorded.clear()


@pytest.mark.parametrize(
    "url",
    [
        "https://host:abc",
        "https://host:99999",
        "https://host/#part",
        "https://host/#",
        "https://host/?a=1",
        "https://host/?",
        "https://user@host",
        "https://:secret@host",
    ],
)
def test_an_address_that_cannot_work_is_refused(url):
    with pytest.raises(server_link.LinkError) as refused:
        server_link.clean_url(url)
    assert refused.value.state == server_link.INVALID_URL


@pytest.mark.parametrize("url", ["https://ho\x01st", "https://xn--a.com"])
def test_an_address_only_the_http_client_rejects_is_refused_too(client, signed_in, server, url):
    answer = client.put("/server-link", json={"url": url, "key": "the-key"})
    assert answer.status_code == 200
    assert answer.json()["error"] == server_link.INVALID_URL
    assert server_link.status(ALICE)["linked"] is False


@pytest.mark.parametrize(
    "broken",
    [
        {},
        {"url": "https://x", "key": "k"},
        {"url": "https://x", "key": "k", "account": {"username": "alice"}},
        {"url": "https://x", "key": "k", "account": "alice"},
        {"url": 1, "key": "k", "account": ALICE._asdict()},
        {"url": "https://x", "key": "k", "account": ALICE._asdict(), "settings_identity": ["a"]},
        {"url": "https://x", "key": "k", "account": ALICE._asdict(), "pending_settings": None},
        ["not", "a", "pairing"],
    ],
)
def test_a_pairing_file_of_the_wrong_shape_counts_as_not_paired(broken):
    os.makedirs(server_link._DATA_DIR)
    with open(server_link._path(), "w", encoding="utf-8") as f:
        json.dump(broken, f)
    assert server_link.status(ALICE)["linked"] is False
    assert server_link.is_linked(ALICE) is False
    assert server_link.send_once() is True


def test_a_setting_changed_with_no_list_of_pending_ones_is_kept(server):
    server_link.pair(ALICE, ALICE_SETTINGS, URL, "the-key")
    link = server_link._read()
    del link["pending_settings"]
    server_link._write(link)
    server_link.note_settings_changed(ALICE_SETTINGS, {"locale": "de"})
    assert server_link._read()["pending_settings"] == {"locale": "de"}


@pytest.mark.parametrize(
    "pull",
    [
        lambda: server_link.pull_settings(ALICE_SETTINGS),
        lambda: server_link.summary_for(ALICE),
        lambda: server_link.pull_lyrics_offsets(ALICE),
        lambda: server_link.charts_for(ALICE, "week"),
    ],
    ids=["settings", "summary", "lyrics offsets", "charts"],
)
def test_a_pull_that_gets_through_ends_the_unreachable_state(paired, pull):
    paired.fail = httpx.ConnectError("down")
    assert server_link.send_once() is False
    assert server_link.status(ALICE)["state"] == server_link.UNREACHABLE

    paired.fail = None
    assert pull() is not None

    assert server_link.status(ALICE)["state"] == server_link.CONNECTED
    assert server_link._next_delay() == server_link.IDLE_SECONDS


def test_a_key_of_another_account_is_refused_before_anything_moves(server):
    server.username = "bob"
    play()
    with pytest.raises(server_link.LinkError) as refused:
        server_link.pair(ALICE, ALICE_SETTINGS, URL, "the-key")
    assert refused.value.state == server_link.KEY_OF_ANOTHER_ACCOUNT
    assert server_link.status(ALICE)["linked"] is False
    assert [r.url.path for r in server.requests] == ["/device-link/info"]


def test_pairing_says_so_when_the_key_is_somebody_elses(client, signed_in, server):
    server.username = "bob"
    answer = client.put("/server-link", json={"url": URL, "key": "the-key"}).json()
    assert answer["linked"] is False
    assert answer["error"] == server_link.KEY_OF_ANOTHER_ACCOUNT


def test_pairing_keeps_the_key_private(server):
    answer = server_link.pair(ALICE, ALICE_SETTINGS, URL, "the-key")
    assert answer["linked"] is True
    assert answer["remote_username"] == "Alice"
    assert "the-key" not in json.dumps(answer)
    assert "the-key" not in json.dumps(server_link.status(ALICE))
    mode = os.stat(server_link._path()).st_mode
    assert stat.S_IMODE(mode) == 0o600


@pytest.mark.parametrize(
    "response,state",
    [
        (httpx.Response(401, json={"detail": server_link.INVALID_KEY_DETAIL}), "wrong_key"),
        (httpx.Response(302, headers={"location": "https://login.example"}), "blocked"),
        (httpx.Response(401, text="Authentik says no"), "blocked"),
        (httpx.Response(404), "server_too_old"),
        (httpx.Response(200, text="<html>the app</html>"), "server_too_old"),
        (httpx.Response(500), "unreachable"),
        (httpx.ConnectError("down"), "unreachable"),
    ],
)
def test_a_failed_pairing_says_why_and_keeps_nothing(server, response, state):
    server.fail = response
    with pytest.raises(server_link.LinkError) as caught:
        server_link.pair(ALICE, ALICE_SETTINGS, URL, "the-key")
    assert caught.value.state == state
    assert server_link.status(ALICE)["linked"] is False


@pytest.mark.parametrize(
    "url,state",
    [
        ("ftp://beacon.example", "invalid_url"),
        ("beacon.example", "invalid_url"),
        ("https://user:pw@beacon.example", "invalid_url"),
        ("http://93.184.216.34:7070", "insecure_url"),
    ],
)
def test_addresses_that_are_refused(url, state):
    with pytest.raises(server_link.LinkError) as caught:
        server_link.clean_url(url)
    assert caught.value.state == state


@pytest.mark.parametrize("host", ["10.0.0.5", "100.100.100.100"], ids=["home", "tailscale"])
def test_plain_http_is_fine_off_the_internet(host):
    assert server_link.clean_url(f"http://{host}:7070/") == f"http://{host}:7070"


def test_https_is_accepted_anywhere():
    assert server_link.clean_url("https://beacon.example/") == URL


def test_plays_go_out_and_are_marked_sent(paired):
    play()
    assert server_link.send_once(now=NOW) is True
    [batch] = paired.sent("POST", "/listens")
    assert [r["song_id"] for r in batch["listens"]] == ["s1"]
    assert play_history.count_unsent(ALICE) == 0


def test_another_accounts_plays_stay_here(paired):
    play(BOB)
    server_link.send_once(now=NOW)
    assert paired.sent("POST", "/listens") == []
    assert play_history.count_unsent(BOB) == 1


def test_imported_rows_are_not_sent(paired):
    play_history.replace_imported(ALICE, "lastfm", [{"ts": NOW - 500, "title": "x"}])
    server_link.send_once(now=NOW)
    assert paired.sent("POST", "/listens") == []


@pytest.mark.parametrize(
    "failure",
    [httpx.Response(500), httpx.ConnectError("down")],
)
def test_a_failed_send_stays_unsent(paired, failure):
    play()
    paired.fail = failure
    assert server_link.send_once(now=NOW) is False
    assert play_history.count_unsent(ALICE) == 1
    assert server_link.status(ALICE)["state"] == "unreachable"


def test_a_long_backlog_goes_out_in_batches(paired, monkeypatch):
    monkeypatch.setattr(server_link, "_BATCH_SIZE", 2)
    for i in range(5):
        play(song_id=f"s{i}", now=NOW + i * 100)
    server_link.send_once(now=NOW)
    assert [len(b["listens"]) for b in paired.sent("POST", "/listens")] == [2, 2, 1]
    assert play_history.count_unsent(ALICE) == 0


def test_the_first_sync_is_a_backfill_and_later_ones_are_not(server):
    play()
    server_link.pair(ALICE, ALICE_SETTINGS, URL, "the-key")
    server_link.send_once(now=NOW)
    play(song_id="s2", now=NOW + 100)
    server_link.send_once(now=NOW)
    assert [b["backfill"] for b in server.sent("POST", "/listens")] == [True, False]


def test_pairing_again_sends_everything_again(server):
    play()
    server_link.pair(ALICE, ALICE_SETTINGS, URL, "the-key")
    server_link.send_once(now=NOW)
    assert play_history.count_unsent(ALICE) == 0
    server_link.unpair()
    server_link.pair(ALICE, ALICE_SETTINGS, "https://other.example", "other-key")
    assert play_history.count_unsent(ALICE) == 1


def test_unpairing_keeps_the_local_log(paired):
    play()
    server_link.unpair()
    assert own_timestamps() == [NOW]
    assert server_link.status(ALICE) == {"available": True, "linked": False}


def test_status_shows_when_another_account_is_signed_in(paired):
    assert server_link.status(BOB)["state"] == "other_account"
    assert server_link.status(None)["state"] == "other_account"


def test_a_wrong_key_shows_up_in_the_status(paired):
    play()
    paired.fail = httpx.Response(401, json={"detail": server_link.INVALID_KEY_DETAIL})
    server_link.send_once(now=NOW)
    assert server_link.status(ALICE)["state"] == "wrong_key"


def test_an_idle_pass_notices_a_revoked_key(paired):
    paired.fail = httpx.Response(401, json={"detail": server_link.INVALID_KEY_DETAIL})
    assert server_link.send_once(now=NOW) is False
    assert server_link.status(ALICE)["state"] == "wrong_key"


def test_success_records_the_sync_time(paired):
    server_link.send_once(now=NOW)
    assert server_link.status(ALICE)["last_sync_at"] == NOW


def test_backoff_grows_and_has_a_ceiling(paired):
    paired.fail = httpx.ConnectError("down")
    delays = []
    for _ in range(10):
        server_link.send_once(now=NOW)
        delays.append(server_link._next_delay())
    assert delays[0] == server_link._BACKOFF_BASE_SECONDS
    assert delays[1] == server_link._BACKOFF_BASE_SECONDS * 2
    assert delays[-1] == server_link._BACKOFF_MAX_SECONDS
    paired.fail = None
    server_link.send_once(now=NOW)
    assert server_link._next_delay() == server_link.IDLE_SECONDS


async def _wait_for(condition) -> None:
    for _ in range(200):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("never happened")


async def test_the_sender_runs_at_once_and_again_when_woken(monkeypatch):
    passes = []
    monkeypatch.setattr(server_link, "send_once", lambda: passes.append(1) or True)
    task = asyncio.create_task(real_run())
    try:
        await _wait_for(lambda: len(passes) == 1)
        server_link.wake()
        await _wait_for(lambda: len(passes) == 2)
    finally:
        task.cancel()


async def test_a_new_play_does_not_cut_a_backoff_short(monkeypatch):
    passes = []
    monkeypatch.setattr(server_link, "send_once", lambda: passes.append(1) or True)
    server_link._note(server_link.UNREACHABLE)
    task = asyncio.create_task(real_run())
    try:
        await _wait_for(lambda: len(passes) == 1)
        server_link.wake()
        await asyncio.sleep(0.05)
        assert len(passes) == 1
        server_link.wake(force=True)
        await _wait_for(lambda: len(passes) == 2)
    finally:
        task.cancel()


async def test_the_sender_does_nothing_on_a_docker_install(monkeypatch):
    monkeypatch.setattr(server_link, "AVAILABLE", False)
    await asyncio.wait_for(real_run(), timeout=1)


def test_summary_is_the_servers_plus_what_is_unsent(paired):
    play(song_id="s1", now=int(time.time()))
    answer = server_link.summary_for(ALICE)
    assert answer["total"] == 2
    assert len(answer["timestamps"]) == 2
    assert answer["timestamps"] == sorted(answer["timestamps"])
    assert answer["recent_plays"] == {"s9": 1, "s1": 1}
    assert answer["milestones"] == {"plays": 3}
    assert answer["top"]["songs"][0]["value"] == 1


def test_charts_add_up_with_the_server(paired):
    song = play_history._charts([{"title": "T", "artist": "A"}])["songs"][0]["id"]
    paired.summary["top"]["songs"] = [{"id": song, "value": 4, "label": "T"}]
    play(now=NOW)
    assert server_link.summary_for(ALICE)["top"]["songs"][0]["value"] == 5


def test_summary_falls_back_when_the_server_is_away(paired):
    paired.fail = httpx.ConnectError("down")
    assert server_link.summary_for(ALICE) is None


def test_summary_is_local_for_another_account(paired):
    assert server_link.summary_for(BOB) is None
    assert paired.requests == []


def test_the_summary_route_answers_from_the_server(client, signed_in, paired):
    assert client.get("/play-history/summary").json()["milestones"] == {"plays": 3}


def test_the_summary_route_survives_a_server_outage(client, signed_in, paired):
    play(now=NOW)
    paired.fail = httpx.ConnectError("down")
    assert client.get("/play-history/summary").json()["timestamps"] == [NOW]


def test_charts_are_the_servers_plus_what_is_unsent(paired):
    now = int(time.time())
    song = play_history._charts([{"title": "T", "artist": "A"}])["songs"][0]["id"]
    paired.charts = {
        "period": "all_time",
        "total": 4,
        "top": {
            "songs": [{"id": song, "value": 4, "label": "T"}],
            "artists": [],
            "albums": [],
            "genres": [],
        },
    }
    play(now=now)
    answer = server_link.charts_for(ALICE, "all_time")
    assert answer["total"] == 5
    assert answer["top"]["songs"][0]["value"] == 5


def test_unsent_plays_outside_the_window_do_not_count(paired):
    now = int(time.time())
    paired.charts["total"] = 4
    play(now=now - 40 * DAY)
    answer = server_link.charts_for(ALICE, "week")
    assert answer["period"] == "week"
    assert answer["total"] == 4


def test_charts_fall_back_when_the_server_is_away(paired):
    paired.fail = httpx.ConnectError("down")
    assert server_link.charts_for(ALICE, "week") is None


def test_charts_are_local_for_another_account(paired):
    assert server_link.charts_for(BOB, "week") is None
    assert paired.requests == []


def test_the_charts_route_answers_from_the_server(client, signed_in, paired):
    paired.charts["total"] = 9
    answer = client.get("/play-history/charts?period=month").json()
    assert answer["period"] == "month"
    assert answer["total"] == 9


def test_the_charts_route_survives_a_server_outage(client, signed_in, paired):
    play(now=int(time.time()))
    paired.fail = httpx.ConnectError("down")
    answer = client.get("/play-history/charts?period=all_time").json()
    assert answer["total"] == 1


def test_recording_a_play_stays_local_when_the_server_is_away(client, signed_in, paired):
    paired.fail = httpx.ConnectError("down")
    response = client.post("/play-history", json={"song_id": "s1", "title": "T"})
    assert response.json() == {"recorded": True}


def test_milestones_are_saved_in_both_places(client, signed_in, paired):
    body = {"plays": 1, "hours": 2, "streak": 3, "records": 0}
    client.put("/play-history/milestones", json=body)
    assert play_history.milestones(ALICE) == body
    server_link.send_once(now=NOW)
    assert paired.sent("PUT", "/milestones") == [body]


def test_pairing_does_not_push_old_milestones(server):
    play_history.save_milestones(ALICE, {"plays": 3})
    server_link.pair(ALICE, ALICE_SETTINGS, URL, "the-key")
    server_link.send_once(now=NOW)
    assert server.sent("PUT", "/milestones") == []


def test_import_is_refused_while_paired(client, signed_in, paired):
    response = client.post("/play-history/import", json={"source": "listenbrainz", "username": "a"})
    assert response.status_code == 409
    assert client.get("/play-history/import").json()["paired"] is True


# ── settings ─────────────────────────────────────────────────────────────


def settings_body(**settings) -> dict:
    return {
        "server_type": ALICE_SETTINGS[0],
        "server_url": ALICE_SETTINGS[1],
        "username": ALICE_SETTINGS[2],
        "settings": settings,
    }


def read_settings(client) -> dict:
    return client.get(
        "/account-settings",
        params={
            "server_type": ALICE_SETTINGS[0],
            "server_url": ALICE_SETTINGS[1],
            "username": ALICE_SETTINGS[2],
        },
    ).json()


def test_first_pairing_merges_with_the_server_winning(client, server):
    account_settings.save(*ALICE_SETTINGS, {"locale": "fr", "fanartEnabled": True})
    server.settings = {"locale": "de"}
    server_link.pair(ALICE, ALICE_SETTINGS, URL, "the-key")
    server_link.send_once(now=NOW)
    assert server.sent("PATCH", "/settings") == [{"settings": {"fanartEnabled": True}}]
    assert read_settings(client)["locale"] == "de"


def test_a_change_goes_to_the_server(client, paired):
    client.post("/account-settings", json=settings_body(locale="it"))
    server_link.send_once(now=NOW)
    assert paired.sent("PATCH", "/settings") == [{"settings": {"locale": "it"}}]


def test_a_change_is_only_sent_once(client, paired):
    client.post("/account-settings", json=settings_body(locale="it"))
    server_link.send_once(now=NOW)
    server_link.send_once(now=NOW)
    assert len(paired.sent("PATCH", "/settings")) == 1


def test_a_field_that_is_not_shared_stays_here(client, paired):
    client.post("/account-settings", json=settings_body(releaseNotesSeen="1.0"))
    server_link.send_once(now=NOW)
    assert paired.sent("PATCH", "/settings") == []
    assert read_settings(client)["releaseNotesSeen"] == "1.0"


def test_another_accounts_settings_do_not_go_up(client, paired):
    body = {**settings_body(locale="it"), "username": "bob"}
    client.post("/account-settings", json=body)
    server_link.send_once(now=NOW)
    assert paired.sent("PATCH", "/settings") == []


def test_unsent_changes_show_over_the_servers_value(client, paired):
    paired.settings = {"locale": "de"}
    paired.fail = httpx.ConnectError("down")
    client.post("/account-settings", json=settings_body(locale="it"))
    server_link.send_once(now=NOW)
    paired.fail = None
    assert read_settings(client)["locale"] == "it"


def test_settings_answer_locally_with_the_server_away(client, paired):
    account_settings.save(*ALICE_SETTINGS, {"locale": "fr"})
    paired.fail = httpx.ConnectError("down")
    assert read_settings(client) == {"locale": "fr"}


def test_a_failed_send_keeps_the_change(client, paired):
    client.post("/account-settings", json=settings_body(locale="it"))
    paired.fail = httpx.Response(500)
    assert server_link.send_once(now=NOW) is False
    paired.fail = None
    server_link.send_once(now=NOW)
    assert paired.sent("PATCH", "/settings")[-1] == {"settings": {"locale": "it"}}


def test_a_field_changed_while_sending_is_sent_again(client, paired):
    client.post("/account-settings", json=settings_body(locale="it"))

    def change_during_send(request):
        if request.method == "PATCH":
            paired.on_request = None
            server_link.note_settings_changed(ALICE_SETTINGS, {"locale": "es"})

    paired.on_request = change_during_send
    server_link.send_once(now=NOW)
    server_link.send_once(now=NOW)
    assert [b["settings"]["locale"] for b in paired.sent("PATCH", "/settings")] == ["it", "es"]


def test_what_the_server_sent_is_kept_for_when_it_is_away(client, paired):
    paired.settings = {"locale": "de"}
    read_settings(client)
    assert account_settings.load(*ALICE_SETTINGS) == {"locale": "de"}


def test_the_server_never_receives_its_own_values_back(client, paired):
    paired.settings = {"locale": "de"}
    read_settings(client)
    server_link.send_once(now=NOW)
    assert paired.sent("PATCH", "/settings") == []


# ── lyrics corrections ───────────────────────────────────────────────────


def test_corrections_belong_to_one_account():
    lyrics_offsets.save(ALICE, {"s1": 1.5})
    assert lyrics_offsets.load(ALICE) == {"s1": 1.5}
    assert lyrics_offsets.load(BOB) == {}


def test_a_correction_taken_back_is_still_known():
    lyrics_offsets.save(ALICE, {"s1": 1.5})
    lyrics_offsets.save(ALICE, {"s1": 0})
    assert lyrics_offsets.load(ALICE) == {"s1": 0}


def test_saving_one_song_leaves_the_others():
    lyrics_offsets.save(ALICE, {"s1": 1.5})
    lyrics_offsets.save(ALICE, {"s2": 2.0})
    assert lyrics_offsets.load(ALICE) == {"s1": 1.5, "s2": 2.0}


def test_new_songs_stop_at_the_limit_but_known_ones_still_change(monkeypatch):
    monkeypatch.setattr(lyrics_offsets, "MAX_PER_ACCOUNT", 2)
    lyrics_offsets.save(ALICE, {"s1": 1.0, "s2": 2.0, "s3": 3.0})
    lyrics_offsets.save(ALICE, {"s1": 9.0})
    assert lyrics_offsets.load(ALICE) == {"s1": 9.0, "s2": 2.0}


def test_the_routes_use_the_sessions_account(client, signed_in):
    client.put("/lyrics-offsets", json={"offsets": {"s1": 1.5}})
    assert client.get("/lyrics-offsets").json() == {"offsets": {"s1": 1.5}}
    assert lyrics_offsets.load(ALICE) == {"s1": 1.5}


def test_the_routes_need_a_verified_session(client):
    assert client.get("/lyrics-offsets").status_code == 401
    assert client.put("/lyrics-offsets", json={"offsets": {}}).status_code == 401


@pytest.mark.parametrize(
    "offsets",
    [{"s": 1e9}, {"": 1.0}, {"x" * 201: 1.0}, {str(i): 1.0 for i in range(501)}],
)
def test_nonsense_corrections_are_refused(client, signed_in, offsets):
    assert client.put("/lyrics-offsets", json={"offsets": offsets}).status_code == 422
    assert lyrics_offsets.load(ALICE) == {}


def test_a_session_without_an_account_has_none(client, default_session):
    default_session.account_username = ""
    assert client.get("/lyrics-offsets").json() == {"offsets": {}}
    assert client.put("/lyrics-offsets", json={"offsets": {"s": 1.0}}).status_code == 200


def test_the_server_files_corrections_under_the_key(public):
    key = key_for()
    public.patch("/device-link/lyrics-offsets", headers=auth(key), json={"offsets": {"s1": 2.5}})
    assert lyrics_offsets.load(ALICE) == {"s1": 2.5}
    assert lyrics_offsets.load(BOB) == {}
    assert public.get("/device-link/lyrics-offsets", headers=auth(key)).json() == {
        "offsets": {"s1": 2.5}
    }


def test_corrections_need_a_key(public):
    assert public.get("/device-link/lyrics-offsets").status_code == 401
    assert public.patch("/device-link/lyrics-offsets").status_code == 401


def test_a_correction_goes_to_the_server(client, signed_in, paired):
    client.put("/lyrics-offsets", json={"offsets": {"s1": 1.5}})
    server_link.send_once(now=NOW)
    assert paired.sent("PATCH", "/lyrics-offsets") == [{"offsets": {"s1": 1.5}}]
    server_link.send_once(now=NOW)
    assert len(paired.sent("PATCH", "/lyrics-offsets")) == 1


def test_a_lot_of_corrections_go_out_in_batches(paired, monkeypatch):
    monkeypatch.setattr(server_link, "_OFFSET_BATCH_SIZE", 2)
    server_link.note_lyrics_offsets(ALICE, {f"s{i}": 1.0 for i in range(5)})
    server_link.send_once(now=NOW)
    assert [len(b["offsets"]) for b in paired.sent("PATCH", "/lyrics-offsets")] == [2, 2, 1]


def test_a_failed_send_keeps_the_correction(paired):
    server_link.note_lyrics_offsets(ALICE, {"s1": 1.5})
    paired.fail = httpx.Response(500)
    assert server_link.send_once(now=NOW) is False
    paired.fail = None
    server_link.send_once(now=NOW)
    assert paired.sent("PATCH", "/lyrics-offsets") == [{"offsets": {"s1": 1.5}}]


def test_a_correction_changed_while_sending_goes_again(paired):
    server_link.note_lyrics_offsets(ALICE, {"s1": 1.5})

    def change_during_send(request):
        if request.method == "PATCH":
            paired.on_request = None
            server_link.note_lyrics_offsets(ALICE, {"s1": 2.5})

    paired.on_request = change_during_send
    server_link.send_once(now=NOW)
    server_link.send_once(now=NOW)
    assert [b["offsets"]["s1"] for b in paired.sent("PATCH", "/lyrics-offsets")] == [1.5, 2.5]


def test_another_accounts_corrections_stay_here(paired):
    server_link.note_lyrics_offsets(BOB, {"s1": 1.5})
    server_link.send_once(now=NOW)
    assert paired.sent("PATCH", "/lyrics-offsets") == []


def test_reading_shows_the_server_with_unsent_on_top_and_keeps_a_copy(client, signed_in, paired):
    paired.offsets = {"s1": 1.0, "s2": 2.0}
    server_link.note_lyrics_offsets(ALICE, {"s2": 9.0})
    assert client.get("/lyrics-offsets").json() == {"offsets": {"s1": 1.0, "s2": 9.0}}
    assert lyrics_offsets.load(ALICE) == {"s1": 1.0, "s2": 9.0}


def test_reading_falls_back_with_the_server_away(client, signed_in, paired):
    lyrics_offsets.save(ALICE, {"s1": 1.0})
    paired.fail = httpx.ConnectError("down")
    assert client.get("/lyrics-offsets").json() == {"offsets": {"s1": 1.0}}


def test_pairing_sends_what_only_this_desktop_knows(server):
    lyrics_offsets.save(ALICE, {"mine": 1.0, "both": 2.0})
    server.offsets = {"both": 5.0}
    server_link.pair(ALICE, ALICE_SETTINGS, URL, "the-key")
    server_link.send_once(now=NOW)
    assert server.sent("PATCH", "/lyrics-offsets") == [{"offsets": {"mine": 1.0}}]


def test_a_pairing_made_before_this_feature_keeps_working(paired):
    with server_link._lock:
        link = server_link._read()
        del link["pending_lyrics_offsets"]
        server_link._write(link)
    assert server_link.send_once(now=NOW) is True
    server_link.note_lyrics_offsets(ALICE, {"s1": 1.5})
    server_link.send_once(now=NOW)
    assert paired.sent("PATCH", "/lyrics-offsets") == [{"offsets": {"s1": 1.5}}]


def test_custom_themes_are_shared_settings(public):
    key = key_for()
    themes = [{"id": "custom-a", "name": "Mine", "background": "#111111", "primary": "#222222"}]
    public.patch(
        "/device-link/settings", headers=auth(key), json={"settings": {"customThemes": themes}}
    )
    assert public.get("/device-link/settings", headers=auth(key)).json() == {"customThemes": themes}


# ── API keys ─────────────────────────────────────────────────────────────


def sharing_key() -> str:
    return device_keys.create(ALICE, "Laptop", ALICE_SETTINGS, scopes=("sync", "api_keys"))["key"]


def test_a_device_confirmed_for_it_gets_the_installations_keys(public):
    api_keys.set("lastfm", "lastfm-secret")
    answer = public.get("/device-link/api-keys", headers=auth(sharing_key())).json()
    assert answer == {"keys": {"lastfm": "lastfm-secret", "fanart": ""}}


def test_a_device_without_that_confirmation_does_not(public):
    api_keys.set("lastfm", "lastfm-secret")
    response = public.get("/device-link/api-keys", headers=auth(key_for()))
    assert response.json() == {"keys": {}}


def test_api_keys_need_a_device_key(public):
    assert public.get("/device-link/api-keys").status_code == 401


@pytest.mark.parametrize("is_admin", [True, False])
def test_only_the_confirmation_decides_not_the_role(client, on_server, is_admin):
    on_server.account_is_admin = is_admin
    without = client.post("/device-keys", json={"label": "Laptop", "scopes": ["sync"]}).json()
    confirmed = client.post(
        "/device-keys", json={"label": "Desktop", "scopes": ["sync", "api_keys"]}
    ).json()
    assert "api_keys" not in device_keys.resolve(without["key"]).scopes
    assert "api_keys" in device_keys.resolve(confirmed["key"]).scopes


def test_the_list_says_what_each_key_may_do(client, on_server):
    client.post("/device-keys", json={"label": "Laptop", "scopes": ["sync"]})
    made = client.post("/device-keys", json={"label": "Display", "scopes": ["history"]}).json()
    listed = {
        entry["label"]: entry["scopes"] for entry in client.get("/device-keys").json()["keys"]
    }
    assert made["scopes"] == ["history"]
    assert listed == {"Laptop": ["sync"], "Display": ["history"]}


def test_the_desktop_uses_the_servers_key(paired):
    paired.api_keys = {"lastfm": "from-server"}
    server_link.send_once(now=NOW)
    assert api_keys.get("lastfm") == "from-server"
    assert api_keys.status("lastfm") == {
        "configured": True,
        "fromEnvironment": False,
        "fromServer": True,
    }


def test_a_key_entered_here_stays_in_charge(paired):
    api_keys.set("lastfm", "my-own")
    paired.api_keys = {"lastfm": "from-server"}
    server_link.send_once(now=NOW)
    assert api_keys.get("lastfm") == "my-own"
    assert api_keys.status("lastfm")["fromServer"] is False
    server_link.unpair()
    assert api_keys.get("lastfm") == "my-own"


def test_the_environment_stays_ahead_of_the_server(paired, monkeypatch):
    monkeypatch.setenv("LASTFM_API_KEY", "from-env")
    paired.api_keys = {"lastfm": "from-server"}
    server_link.send_once(now=NOW)
    assert api_keys.get("lastfm") == "from-env"
    assert api_keys.status("lastfm")["fromEnvironment"] is True


def test_a_key_removed_on_the_server_goes_here_too(paired):
    paired.api_keys = {"lastfm": "from-server"}
    server_link.send_once(now=NOW)
    paired.api_keys = {}
    server_link.send_once(now=NOW)
    assert api_keys.get("lastfm") == ""


def test_disconnecting_returns_the_lent_keys(paired):
    paired.api_keys = {"lastfm": "from-server"}
    server_link.send_once(now=NOW)
    server_link.unpair()
    assert api_keys.get("lastfm") == ""


def test_a_revoked_device_loses_them(paired):
    paired.api_keys = {"lastfm": "from-server"}
    server_link.send_once(now=NOW)
    paired.fail = httpx.Response(401, json={"detail": server_link.INVALID_KEY_DETAIL})
    server_link.send_once(now=NOW)
    assert api_keys.get("lastfm") == ""


def test_a_server_that_is_away_does_not_take_them(paired):
    paired.api_keys = {"lastfm": "from-server"}
    server_link.send_once(now=NOW)
    paired.fail = httpx.ConnectError("down")
    server_link.send_once(now=NOW)
    assert api_keys.get("lastfm") == "from-server"


def test_the_lent_key_is_not_world_readable(paired):
    paired.api_keys = {"lastfm": "from-server"}
    server_link.send_once(now=NOW)
    assert stat.S_IMODE(os.stat(api_keys._shared_path("lastfm")).st_mode) == 0o600


# ── the desktop's routes ─────────────────────────────────────────────────


def test_pairing_over_http_uses_the_sessions_account(client, signed_in, server):
    answer = client.put("/server-link", json={"url": URL, "key": "the-key"}).json()
    assert answer["linked"] is True
    assert server_link.is_linked(ALICE)
    assert not server_link.is_linked(BOB)


def test_a_rejected_key_comes_back_as_a_reason(client, signed_in, server):
    server.fail = httpx.Response(401, json={"detail": server_link.INVALID_KEY_DETAIL})
    answer = client.put("/server-link", json={"url": URL, "key": "bad"}).json()
    assert answer == {"available": True, "linked": False, "error": "wrong_key"}


def test_a_docker_install_refuses_to_pair(client, signed_in, server, monkeypatch):
    monkeypatch.setattr(server_link, "AVAILABLE", False)
    assert client.put("/server-link", json={"url": URL, "key": "k"}).status_code == 404
    assert server.requests == []
    assert client.get("/server-link").json()["available"] is False


def test_the_routes_need_a_session(client):
    assert client.get("/server-link").status_code == 401
    assert client.put("/server-link", json={"url": URL, "key": "k"}).status_code == 401
    assert client.delete("/server-link").status_code == 401


def test_unpairing_over_http(client, signed_in, paired):
    assert client.delete("/server-link").json()["linked"] is False
    assert not server_link.is_linked(ALICE)


# ── scopes ───────────────────────────────────────────────────────────────


APP_ONLY = ("history", "stats", "now_playing", "lyrics")


def app_key(*scopes: str) -> str:
    return device_keys.create(ALICE, "Display", ALICE_SETTINGS, scopes=scopes or APP_ONLY)["key"]


@pytest.mark.parametrize(
    "method, path",
    [
        ("POST", "/device-link/listens"),
        ("GET", "/device-link/summary"),
        ("GET", "/device-link/charts"),
        ("PUT", "/device-link/milestones"),
        ("GET", "/device-link/settings"),
        ("PATCH", "/device-link/settings"),
        ("GET", "/device-link/api-keys"),
        ("GET", "/device-link/lyrics-offsets"),
        ("PATCH", "/device-link/lyrics-offsets"),
    ],
)
def test_an_apps_key_stays_out_of_what_the_desktop_uses(public, method, path):
    response = public.request(method, path, headers=auth(app_key()))
    assert response.status_code == 403


@pytest.mark.parametrize(
    "scopes",
    [
        [],
        ["nonsense"],
        ["api_keys"],
        ["lyrics"],
        ["library"],
        ["sync", "history"],
        ["sync", "control"],
    ],
)
def test_a_key_cannot_be_made_with_a_combination_nobody_should_have(client, on_server, scopes):
    response = client.post("/device-keys", json={"label": "x", "scopes": scopes})
    assert response.status_code == 422


@pytest.mark.parametrize(
    "scopes",
    [
        ["sync"],
        ["api_keys", "sync"],
        ["history"],
        ["lyrics", "now_playing"],
        ["control"],
        ["control", "library"],
    ],
)
def test_the_combinations_the_form_offers_are_accepted(client, on_server, scopes):
    assert client.post("/device-keys", json={"label": "x", "scopes": scopes}).status_code == 200


@pytest.mark.parametrize("scopes", [["sync"], ["api_keys", "sync"]])
def test_a_desktop_does_not_hand_out_what_pairs_a_desktop(client, signed_in, scopes):
    response = client.post("/device-keys", json={"label": "x", "scopes": scopes})
    assert response.status_code == 422
    assert device_keys.list_keys(ALICE) == []


@pytest.mark.parametrize("scopes", [["history", "stats"], ["control", "library"]])
def test_a_desktop_hands_out_app_keys(client, signed_in, scopes):
    made = client.post("/device-keys", json={"label": "Home Assistant", "scopes": scopes})
    assert made.status_code == 200
    assert device_keys.resolve(made.json()["key"]).account == ALICE


def test_a_key_that_may_steer_announces_the_desktop(client, signed_in, fake_zeroconf):
    client.post("/device-keys", json={"label": "Display", "scopes": ["now_playing"]})
    assert fake_zeroconf.registered == []
    made = client.post("/device-keys", json={"label": "Home Assistant", "scopes": ["control"]})
    assert len(fake_zeroconf.registered) == 1
    client.delete(f"/device-keys/{made.json()['id']}")
    assert fake_zeroconf.registered == []


def test_a_server_announces_itself_once_a_key_may_steer(client, on_server, fake_zeroconf):
    client.post("/device-keys", json={"label": "Home Assistant", "scopes": ["history"]})
    assert fake_zeroconf.registered == []
    client.post("/device-keys", json={"label": "Home Assistant", "scopes": ["control"]})
    assert len(fake_zeroconf.registered) == 1


def test_a_key_with_no_rights_at_all_is_not_made():
    with pytest.raises(device_keys.InvalidScopes):
        device_keys.create(ALICE, "Display", ALICE_SETTINGS, scopes=())


def test_me_says_who_the_key_is_and_what_it_may_do(public):
    answer = public.get("/device-link/v1/me", headers=auth(app_key("history", "stats"))).json()
    assert answer["username"] == ALICE.username
    assert answer["scopes"] == ["history", "stats"]
    assert answer["api_version"] == 1
    assert answer["beacon_version"]


@pytest.mark.parametrize("desktop", [True, False])
def test_me_says_whether_the_player_is_a_desktop_app_or_a_server(public, monkeypatch, desktop):
    monkeypatch.setattr(server_link, "AVAILABLE", desktop)
    answer = public.get("/device-link/v1/me", headers=auth(app_key("history"))).json()
    assert answer["player"] == ("desktop" if desktop else "server")


def test_me_needs_a_key(public):
    assert public.get("/device-link/v1/me").status_code == 401


def test_a_revoked_key_is_gone_from_v1_too(public):
    made = device_keys.create(ALICE, "Display", ALICE_SETTINGS, scopes=("history",))
    device_keys.revoke(ALICE, made["id"])
    assert public.get("/device-link/v1/me", headers=auth(made["key"])).status_code == 401


def test_a_desktop_refuses_an_apps_key_when_pairing(server):
    server.scopes = ["history"]
    with pytest.raises(server_link.LinkError) as refused:
        server_link.pair(ALICE, ALICE_SETTINGS, URL, "id.secret")
    assert refused.value.state == server_link.WRONG_KEY
    assert server_link.status(ALICE)["linked"] is False


def test_older_keys_keep_what_they_could_do(tmp_path):
    conn = sqlite3.connect(tmp_path / "old.db")
    conn.row_factory = sqlite3.Row
    for statement in play_history._SCHEMA:
        conn.execute(statement)
    for migrate in play_history._MIGRATIONS[1:4]:
        migrate(conn)
    conn.execute("PRAGMA user_version = 4")
    conn.execute(
        "INSERT INTO accounts (id, server_type, server_url, username) VALUES (1, 's', 'u', 'a')"
    )
    for key_id, may_read in (("plain", 0), ("trusted", 1)):
        conn.execute(
            "INSERT INTO device_keys"
            " (id, account_id, key_hash, label, created_at, may_read_api_keys)"
            " VALUES (?, 1, 'h', 'l', 0, ?)",
            (key_id, may_read),
        )
    conn.commit()

    play_history._prepare(conn)

    scopes = dict(conn.execute("SELECT id, scopes FROM device_keys").fetchall())
    assert scopes == {"plain": "sync", "trusted": "api_keys,sync"}
    conn.close()


# ── what an app can read ─────────────────────────────────────────────────


def history_key(*scopes: str) -> str:
    return app_key(*(scopes or ("history",)))


def history(public, key, **params):
    return public.get("/device-link/v1/history", headers=auth(key), params=params)


def delivered(*listens, account=ALICE):
    play_history.receive_listens(account, list(listens), now=NOW)


def imported(ts: int, source="lastfm", account=ALICE):
    play_history.replace_imported(
        account, source, [{"ts": ts, "song_id": "", "title": "Old", "artist": "A"}]
    )


def test_history_returns_a_fixed_list_of_fields(public):
    delivered(row("a" * 32, NOW - 10, song_id="s1", cover_art_id="secret-id"))
    item = history(public, history_key()).json()["items"][0]
    assert set(item) == {
        "id",
        "ts",
        "source",
        "song_id",
        "title",
        "artist",
        "artist_id",
        "album",
        "album_id",
        "genre",
        "duration",
    }
    assert item["id"] == "a" * 32
    assert item["source"] == "beacon"


def test_history_pages_through_in_order_of_arrival(public):
    delivered(*(row(f"{i:032x}", NOW - 1000 + i * 100) for i in range(3)))
    key = history_key()
    first = history(public, key, limit=2).json()
    assert [item["id"][-1] for item in first["items"]] == ["0", "1"]
    assert first["more"] is True
    second = history(public, key, limit=2, cursor=first["next_cursor"]).json()
    assert [item["id"][-1] for item in second["items"]] == ["2"]
    assert second["more"] is False


def test_history_is_in_order_of_arrival_not_of_time_played(public):
    delivered(row("a" * 32, NOW - 10), row("b" * 32, NOW - 5 * DAY))
    answer = history(public, history_key()).json()
    assert [item["id"] for item in answer["items"]] == ["a" * 32, "b" * 32]


def test_a_late_delivery_of_old_plays_still_reaches_a_follower(public):
    key = history_key()
    delivered(row("a" * 32, NOW - 10))
    cursor = history(public, key).json()["next_cursor"]
    delivered(row("b" * 32, NOW - 5 * DAY))
    assert [item["id"] for item in history(public, key, cursor=cursor).json()["items"]] == [
        "b" * 32
    ]


def test_a_follower_with_nothing_new_keeps_its_place(public):
    key = history_key()
    delivered(row("a" * 32, NOW - 10))
    cursor = history(public, key).json()["next_cursor"]
    answer = history(public, key, cursor=cursor).json()
    assert answer == {"items": [], "next_cursor": cursor, "more": False}


def test_history_can_be_limited_by_time(public):
    delivered(*(row(f"{i:032x}", NOW - 1000 + i * 100) for i in range(4)))
    answer = history(public, history_key(), since=NOW - 900, until=NOW - 800).json()
    assert [item["ts"] for item in answer["items"]] == [NOW - 900, NOW - 800]


def test_history_is_only_ever_the_keys_own_account(public):
    delivered(row("a" * 32, NOW - 10), account=BOB)
    assert history(public, history_key()).json()["items"] == []


def test_a_replaced_import_expires_older_cursors(public):
    imported(NOW - 5 * DAY)
    key = history_key()
    cursor = history(public, key).json()["next_cursor"]
    imported(NOW - 4 * DAY)
    response = history(public, key, cursor=cursor)
    assert response.status_code == 410
    assert response.json()["detail"] == "cursor_expired"
    assert len(history(public, key).json()["items"]) == 1


def test_a_delivery_that_cuts_an_import_back_expires_older_cursors(public):
    imported(NOW - 2 * DAY)
    key = history_key()
    cursor = history(public, key).json()["next_cursor"]
    delivered(row("a" * 32, NOW - 3 * DAY))
    assert history(public, key, cursor=cursor).status_code == 410


def test_a_first_import_removes_nothing_and_keeps_cursors_valid(public):
    key = history_key()
    delivered(row("a" * 32, NOW - 10))
    cursor = history(public, key).json()["next_cursor"]
    imported(NOW - 5 * DAY)
    response = history(public, key, cursor=cursor)
    assert response.status_code == 200
    assert [item["source"] for item in response.json()["items"]] == ["lastfm"]


def test_one_accounts_removal_leaves_anothers_cursor_alone(public):
    key = history_key()
    delivered(row("a" * 32, NOW - 10))
    cursor = history(public, key).json()["next_cursor"]
    imported(NOW - 5 * DAY, account=BOB)
    imported(NOW - 4 * DAY, account=BOB)
    assert history(public, key, cursor=cursor).status_code == 200


@pytest.mark.parametrize(
    "params", [{"limit": 501}, {"limit": 0}, {"cursor": "nonsense"}, {"since": -1}, {"until": -1}]
)
def test_history_refuses_what_it_cannot_answer(public, params):
    assert history(public, history_key(), **params).status_code == 422


def stats(public, key):
    return public.get("/device-link/v1/stats", headers=auth(key))


def test_stats_answers_with_a_list_of_its_own(public):
    delivered(row("a" * 32, NOW - 10, album="B", cover_art_id="secret-id", genre="Rock"))
    play_history.save_milestones(ALICE, {"plays": 1, "hours": 0, "streak": 1, "records": 0})
    answer = stats(public, history_key("stats")).json()
    assert set(answer) == {"total", "live_since", "top", "milestones", "timestamps"}
    assert answer["total"] == 1
    assert answer["timestamps"] == [NOW - 10]
    assert answer["milestones"]["streak"] == 1
    assert answer["top"]["songs"] == [{"title": "T", "artist": "A", "album_id": "", "plays": 1}]
    assert answer["top"]["artists"] == [{"name": "A", "artist_id": "", "plays": 1}]
    assert answer["top"]["albums"] == [{"title": "B", "artist": "A", "album_id": "", "plays": 1}]
    assert answer["top"]["genres"] == [{"name": "Rock", "plays": 1}]


def test_stats_are_only_ever_the_keys_own_account(public):
    delivered(row("a" * 32, NOW - 10), account=BOB)
    assert stats(public, history_key("stats")).json()["total"] == 0


@pytest.mark.parametrize(
    "path, scope, other",
    [("history", "history", "stats"), ("stats", "stats", "history")],
)
def test_each_read_route_needs_its_own_right(public, path, scope, other):
    url = f"/device-link/v1/{path}"
    assert public.get(url, headers=auth(app_key(scope))).status_code == 200
    assert public.get(url, headers=auth(app_key(other))).status_code == 403
    assert public.get(url, headers=auth(key_for())).status_code == 403
    assert public.get(url).status_code == 401


# ── reaching v1 from a browser, and its limits ───────────────────────────


ELSEWHERE = {"Origin": "https://my-dashboard.example"}


def test_a_page_anywhere_can_preflight_v1_without_a_key(public):
    response = public.options(
        "/device-link/v1/history",
        headers={
            **ELSEWHERE,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": server_link.KEY_HEADER,
        },
    )
    assert response.status_code == 204
    assert response.headers["access-control-allow-origin"] == "*"
    assert (
        server_link.KEY_HEADER.lower() in response.headers["access-control-allow-headers"].lower()
    )


def test_a_page_anywhere_can_read_v1(public):
    response = public.get("/device-link/v1/me", headers={**ELSEWHERE, **auth(app_key())})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"


def test_v1_answers_any_origin_with_one_header_only(public):
    headers = {"Origin": "http://localhost:5173", **auth(app_key())}
    response = public.get("/device-link/v1/me", headers=headers)
    assert response.headers.get_list("access-control-allow-origin") == ["*"]


@pytest.mark.parametrize("key", ["bad.key", None])
def test_a_page_can_read_why_it_was_refused(public, key):
    headers = {**ELSEWHERE, **(auth(key) if key else {})}
    response = public.get("/device-link/v1/me", headers=headers)
    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == "*"


def test_a_crash_reaches_a_page_as_what_it_is(public):
    with patch.object(play_history, "summary", side_effect=RuntimeError):
        response = public.get(
            "/device-link/v1/stats", headers={**ELSEWHERE, **auth(app_key("stats"))}
        )
    assert response.status_code == 500
    assert response.headers["access-control-allow-origin"] == "*"


@pytest.mark.parametrize("path", ["/device-link/info", "/device-link/settings"])
def test_the_desktops_routes_stay_closed_to_other_origins(public, path):
    response = public.get(path, headers={**ELSEWHERE, **auth(key_for())})
    assert "access-control-allow-origin" not in response.headers


def test_the_desktops_routes_get_no_preflight_from_other_origins(public):
    response = public.options(
        "/device-link/settings",
        headers={**ELSEWHERE, "Access-Control-Request-Method": "GET"},
    )
    assert response.headers.get("access-control-allow-origin") != "*"


def test_too_many_requests_are_refused_and_say_when_to_retry(public):
    key = app_key()
    limit = device_link._V1_REQUESTS_PER_KEY[0]
    for _ in range(limit):
        assert public.get("/device-link/v1/me", headers=auth(key)).status_code == 200
    response = public.get("/device-link/v1/me", headers={**ELSEWHERE, **auth(key)})
    assert response.status_code == 429
    assert int(response.headers["retry-after"]) > 0
    assert "retry-after" in response.headers["access-control-expose-headers"].lower()


@pytest.mark.parametrize("path", ["me", "history", "stats"])
def test_every_v1_route_counts_towards_the_limit(public, path):
    key = app_key("history", "stats")
    limit = device_link._V1_REQUESTS_PER_KEY[0]
    for _ in range(limit):
        public.get(f"/device-link/v1/{path}", headers=auth(key))
    assert public.get(f"/device-link/v1/{path}", headers=auth(key)).status_code == 429


def test_one_keys_limit_is_not_anothers(public):
    busy = app_key()
    for _ in range(device_link._V1_REQUESTS_PER_KEY[0] + 1):
        public.get("/device-link/v1/me", headers=auth(busy))
    assert public.get("/device-link/v1/me", headers=auth(app_key())).status_code == 200


def test_the_desktop_is_not_held_to_an_apps_limit(public):
    key = key_for()
    for _ in range(device_link._V1_REQUESTS_PER_KEY[0] + 1):
        response = public.get("/device-link/summary", headers=auth(key))
    assert response.status_code == 200


# ── what is playing now ──────────────────────────────────────────────────


class SpeakerDelivery:
    target = "Living room"


def cast(session, *, song="s1", paused=False, started=100.0, account=ALICE):
    session.account_server_type = account.server_type
    session.account_server_url = account.server_url
    session.account_username = account.username
    st = session.state
    st.is_streaming = True
    st.active_delivery = SpeakerDelivery()
    st.current_track = Track(
        id=song,
        title="Song",
        artist="Artist",
        album="Album",
        duration=214,
        cover_art_id="cover-1",
    )
    st.clock.play_start_time = started
    st.clock.is_paused = paused
    return session


def playing(public, key=None):
    return public.get("/device-link/v1/now-playing", headers=auth(key or app_key("now_playing")))


@pytest.fixture
def at_position():
    with patch("core.now_playing.compute_position", return_value=31.4) as position:
        yield position


def test_nothing_playing_says_so(public):
    assert playing(public).json() == {"playing": False}


def test_a_cast_is_described_with_a_fixed_list_of_fields(public, default_session, at_position):
    cast(default_session)
    answer = playing(public).json()
    assert answer.pop("at") > 0
    assert answer == {
        "playing": True,
        "paused": False,
        "kind": "song",
        "source": "cast",
        "devices": ["Living room"],
        "song": {
            "id": "s1",
            "title": "Song",
            "artist": "Artist",
            "album": "Album",
            "duration": 214,
        },
        "radio": None,
        "position": 31.4,
    }


def test_the_media_servers_credentials_stay_on_the_server(public, default_session, at_position):
    cast(default_session)
    default_session.media.get_cover_art_url = lambda *_a, **_k: "http://media/x?t=SECRET"
    assert "SECRET" not in playing(public).text


def test_a_paused_cast_says_it_is_paused(public, default_session, at_position):
    cast(default_session, paused=True)
    answer = playing(public).json()
    assert answer["playing"] is True
    assert answer["paused"] is True


def test_another_accounts_cast_is_not_shown(public, default_session, at_position):
    cast(default_session, account=BOB)
    assert playing(public).json() == {"playing": False}


@pytest.mark.parametrize(
    "spoil",
    [
        lambda st: setattr(st, "is_streaming", False),
        lambda st: setattr(st, "track_ended", True),
        lambda st: setattr(st, "preview", object()),
        lambda st: setattr(st, "active_delivery", None),
        lambda st: setattr(st.current_track, "id", TEST_TONE_TRACK_ID),
    ],
)
def test_what_is_not_really_playing_is_not_shown(public, default_session, at_position, spoil):
    cast(default_session)
    spoil(default_session.state)
    assert playing(public).json() == {"playing": False}


def add_session(session_id: str) -> SessionState:
    extra = SessionState(session_id)
    session_module.registry._sessions[session_id] = extra
    return extra


def test_of_two_casts_the_last_started_is_shown(public, default_session, at_position):
    cast(default_session, song="older", started=100.0)
    cast(add_session("second"), song="newer", started=200.0)
    assert playing(public).json()["song"]["id"] == "newer"


def test_a_playing_cast_comes_before_a_paused_one(public, default_session, at_position):
    cast(default_session, song="playing", started=100.0)
    cast(add_session("second"), song="paused", started=200.0, paused=True)
    assert playing(public).json()["song"]["id"] == "playing"


def test_radio_has_a_station_and_no_position(public, default_session):
    cast(default_session)
    default_session.state.current_track = None
    default_session.state.radio_info = {"title": "Station One", "url": "http://r"}
    default_session.radio_title = "Artist - Tune"
    answer = playing(public).json()
    assert answer["kind"] == "radio"
    assert answer["song"] is None
    assert answer["radio"] == {"station": "Station One", "title": "Artist - Tune"}
    assert answer["position"] is None


@pytest.mark.parametrize("path", ["now-playing", "now-playing/events", "now-playing/cover"])
def test_now_playing_needs_its_own_right(public, path):
    url = f"/device-link/v1/{path}"
    assert public.get(url, headers=auth(app_key("history"))).status_code == 403
    assert public.get(url, headers=auth(key_for())).status_code == 403
    assert public.get(url).status_code == 401


def test_the_cover_comes_through_the_server_and_is_never_cached(public, default_session):
    cast(default_session)
    served = AsyncMock(return_value=Response(b"img", media_type="image/png"))
    with patch.object(device_link, "cover_image", served):
        response = public.get(
            "/device-link/v1/now-playing/cover", headers=auth(app_key("now_playing"))
        )
    assert response.content == b"img"
    assert response.headers["cache-control"] == "no-store"
    served.assert_awaited_once_with(default_session.media, "cover-1")


def test_no_cover_for_a_song_without_one(public, default_session):
    cast(default_session)
    default_session.state.current_track.cover_art_id = ""
    served = AsyncMock()
    with patch.object(device_link, "cover_image", served):
        response = public.get(
            "/device-link/v1/now-playing/cover", headers=auth(app_key("now_playing"))
        )
    assert response.status_code == 404
    served.assert_not_awaited()


def test_no_cover_when_nothing_is_playing(public):
    response = public.get("/device-link/v1/now-playing/cover", headers=auth(app_key("now_playing")))
    assert response.status_code == 404


def test_no_cover_for_radio(public, default_session):
    cast(default_session)
    default_session.state.current_track = None
    default_session.state.radio_info = {"title": "Station One", "url": "http://r"}
    response = public.get("/device-link/v1/now-playing/cover", headers=auth(app_key("now_playing")))
    assert response.status_code == 404


def song_state(**over) -> dict:
    return {
        "playing": True,
        "paused": False,
        "kind": "song",
        "song": {"id": "s1"},
        "position": 10.0,
        "at": 1000.0,
        **over,
    }


@pytest.mark.parametrize(
    "latest, expected",
    [
        (song_state(position=15.0, at=1005.0), False),
        (song_state(position=16.0, at=1005.0), False),
        (song_state(position=60.0, at=1005.0), True),
        (song_state(position=2.0, at=1005.0), True),
        (song_state(paused=True, position=15.0, at=1005.0), True),
        (song_state(song={"id": "s2"}, position=15.0, at=1005.0), True),
        ({"playing": False}, True),
    ],
)
def test_an_app_hears_about_changes_and_not_about_time_passing(latest, expected):
    assert now_playing.differs(song_state(), latest) is expected


def test_a_paused_song_stays_quiet_while_time_passes():
    shown = song_state(paused=True)
    assert now_playing.differs(shown, song_state(paused=True, at=1100.0)) is False


def stream_of(owner_key: str):
    owner = device_keys.resolve(owner_key)
    return device_link._now_playing_events(owner_key, owner), owner


async def _drain(stream, count: int) -> list[str]:
    return [await anext(stream) for _ in range(count)]


@pytest.fixture
def quick_stream(monkeypatch):
    monkeypatch.setattr(device_link, "_NOW_PLAYING_POLL_SECONDS", 0)
    monkeypatch.setattr(device_link, "_KEEPALIVE_SECONDS", 1000)


def test_a_stream_starts_with_the_current_state(quick_stream, default_session, at_position):
    cast(default_session)
    stream, _ = stream_of(app_key("now_playing"))

    async def run():
        _, first = await _drain(stream, 2)
        await stream.aclose()
        return first

    first = asyncio.run(run())
    assert json.loads(first.removeprefix("data: "))["song"]["id"] == "s1"


def test_a_stream_reports_the_next_song(quick_stream, default_session, at_position):
    cast(default_session)
    stream, _ = stream_of(app_key("now_playing"))

    async def run():
        await _drain(stream, 2)
        default_session.state.current_track.id = "s2"
        change = await anext(stream)
        await stream.aclose()
        return change

    assert json.loads(asyncio.run(run()).removeprefix("data: "))["song"]["id"] == "s2"


def test_a_revoked_key_ends_its_stream(monkeypatch, default_session, at_position):
    monkeypatch.setattr(device_link, "_NOW_PLAYING_POLL_SECONDS", 0.001)
    monkeypatch.setattr(device_link, "_KEEPALIVE_SECONDS", 0.001)
    made = device_keys.create(ALICE, "Display", ALICE_SETTINGS, scopes=("now_playing",))
    stream, _ = stream_of(made["key"])

    async def run():
        await _drain(stream, 2)
        device_keys.revoke(ALICE, made["id"])
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(anext(stream), 5)

    asyncio.run(run())


def test_a_stream_is_kept_alive_and_keeps_the_key_in_use(monkeypatch, default_session):
    monkeypatch.setattr(device_link, "_NOW_PLAYING_POLL_SECONDS", 0.001)
    monkeypatch.setattr(device_link, "_KEEPALIVE_SECONDS", 0.001)
    key = app_key("now_playing")
    stream, _ = stream_of(key)

    async def run():
        await _drain(stream, 2)
        with patch.object(device_keys, "resolve", wraps=device_keys.resolve) as resolve:
            beat = await asyncio.wait_for(anext(stream), 5)
        await stream.aclose()
        return beat, resolve.call_count

    beat, looked_up = asyncio.run(run())
    assert beat.startswith(":")
    assert looked_up == 1


async def _answer_until_gone(response, messages_before_gone: int) -> None:
    """Answers `response` to a client that goes away after that many messages."""
    sent = 0

    async def send(_message) -> None:
        nonlocal sent
        if sent >= messages_before_gone:
            raise OSError("gone")
        sent += 1

    scope = {"type": "http", "asgi": {"spec_version": "2.4"}}
    with pytest.raises(ClientDisconnect):
        await response(scope, None, send)


@pytest.mark.parametrize(
    "messages_before_gone",
    [pytest.param(0, id="before the first byte"), pytest.param(2, id="while streaming")],
)
def test_a_stream_gives_its_place_back_when_the_client_goes(quick_stream, messages_before_gone):
    key = app_key("now_playing")
    owner = device_keys.resolve(key)

    async def run():
        response = await device_link.get_now_playing_events(owner, key)
        assert device_link._open_streams[owner.key_id] == 1
        await _answer_until_gone(response, messages_before_gone)

    asyncio.run(run())
    assert owner.key_id not in device_link._open_streams


def test_streams_opened_at_once_cannot_pass_the_limit_together():
    """Each is counted before any of them has sent a byte."""
    key = app_key("now_playing")
    owner = device_keys.resolve(key)

    async def run():
        for _ in range(device_link._MAX_STREAMS_PER_KEY):
            await device_link.get_now_playing_events(owner, key)
        with pytest.raises(HTTPException) as refused:
            await device_link.get_now_playing_events(owner, key)
        assert refused.value.status_code == 429

    asyncio.run(run())
    device_link._open_streams.clear()


def test_too_many_open_streams_are_refused(public):
    key = app_key("now_playing")
    device_link._open_streams[key.split(".")[0]] = device_link._MAX_STREAMS_PER_KEY
    response = public.get("/device-link/v1/now-playing/events", headers=auth(key))
    assert response.status_code == 429
    assert int(response.headers["retry-after"]) > 0
    device_link._open_streams.clear()


# ── what a window reports it plays by itself ─────────────────────────────


def report(song="s1", paused=False, position=10.0, devices=(), **over) -> dict:
    return {
        "song": {
            "id": song,
            "title": "Song",
            "artist": "Artist",
            "album": "Album",
            "duration": 200,
            "cover_art_id": "cover-1",
        },
        "radio": None,
        "position": position,
        "paused": paused,
        "devices": list(devices),
        **over,
    }


RADIO = {"radio": {"station": "Station One", "title": "Artist - Tune"}, "song": None}


def stored(song="s1", at=NOW, source="session:a", account=ALICE, **over):
    now_playing.store_report(source, account, report(song, **over), now=at)


def test_nobody_is_told_when_no_app_wants_it(client, signed_in):
    assert client.post("/now-playing/report", json=report()).json() == {"wanted": False}
    assert now_playing.current(ALICE)["playing"] is False


def test_a_key_for_something_else_does_not_count(client, signed_in):
    app_key("history")
    assert client.post("/now-playing/report", json=report()).json() == {"wanted": False}


def test_an_app_sees_what_a_browser_plays(client, signed_in, public):
    key = app_key("now_playing")
    assert client.post("/now-playing/report", json=report()).json() == {"wanted": True}
    answer = playing(public, key).json()
    assert answer.pop("at") > 0
    assert answer.pop("position") >= 10.0
    assert answer == {
        "playing": True,
        "paused": False,
        "kind": "song",
        "source": "local",
        "devices": [],
        "song": {
            "id": "s1",
            "title": "Song",
            "artist": "Artist",
            "album": "Album",
            "duration": 200,
        },
        "radio": None,
    }


def test_a_key_revoked_means_the_next_report_is_unwanted(client, signed_in):
    made = device_keys.create(ALICE, "Display", ALICE_SETTINGS, scopes=("now_playing",))
    client.post("/now-playing/report", json=report())
    device_keys.revoke(ALICE, made["id"])
    assert client.post("/now-playing/report", json=report()).json() == {"wanted": False}
    assert now_playing.current(ALICE)["playing"] is False


def test_taking_a_report_back_ends_it(client, signed_in):
    app_key("now_playing")
    client.post("/now-playing/report", json=report())
    client.delete("/now-playing/report")
    assert now_playing.current(ALICE)["playing"] is False


def test_the_report_routes_need_a_token(public):
    assert public.post("/now-playing/report", json=report()).status_code == 401
    assert public.delete("/now-playing/report").status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        report(song=""),
        report(position=-1),
        {**report(), "radio": RADIO["radio"]},
        {**report(), "song": None},
    ],
)
def test_a_report_about_nothing_sensible_is_refused(client, signed_in, body):
    assert client.post("/now-playing/report", json=body).status_code == 422


def test_position_carries_forward_while_playing():
    stored(position=10.0, at=NOW)
    assert now_playing.current(ALICE, now=NOW + 20)["position"] == 30.0


def test_position_stops_at_the_end_of_the_song():
    stored(position=190.0, at=NOW)
    assert now_playing.current(ALICE, now=NOW + 60)["position"] == 200


def test_position_stands_still_while_paused():
    stored(position=10.0, at=NOW, paused=True)
    answer = now_playing.current(ALICE, now=NOW + 20)
    assert answer["position"] == 10.0
    assert answer["paused"] is True


def test_a_report_counts_until_the_window_goes_quiet():
    stored(at=NOW)
    limit = now_playing.REPORT_TTL_SECONDS
    assert now_playing.current(ALICE, now=NOW + limit)["playing"] is True
    assert now_playing.current(ALICE, now=NOW + limit + 1)["playing"] is False


def test_old_reports_do_not_pile_up():
    stored(at=NOW, source="session:gone")
    stored(at=NOW + now_playing.REPORT_TTL_SECONDS + 1, source="session:new")
    assert set(now_playing._reports) == {"session:new"}


def test_reports_can_arrive_while_others_are_read():
    """Reports are stored from worker threads while the event loop reads them."""
    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    done = threading.Event()
    errors: list[Exception] = []

    def repeat(step):
        count = 0
        while not done.is_set():
            count += 1
            try:
                step(count)
            except RuntimeError as e:
                errors.append(e)
                done.set()

    steps = [
        *[lambda n, w=w: stored(at=NOW, source=f"{w}:{n % 64}") for w in range(4)],
        *[lambda n, w=w: now_playing.forget_report(f"{w}:{n % 64}") for w in range(4)],
        *[lambda _: now_playing.current(ALICE, now=NOW) for _ in range(4)],
    ]
    threads = [threading.Thread(target=repeat, args=(step,)) for step in steps]
    try:
        for thread in threads:
            thread.start()
        done.wait(1.0)
    finally:
        done.set()
        for thread in threads:
            thread.join()
        sys.setswitchinterval(interval)
    assert not errors


def test_another_accounts_report_is_not_shown():
    stored(at=NOW, account=BOB)
    assert now_playing.current(ALICE, now=NOW)["playing"] is False


def test_radio_can_be_reported():
    now_playing.store_report("session:a", ALICE, {**report(), **RADIO}, now=NOW)
    answer = now_playing.current(ALICE, now=NOW + 5)
    assert answer["kind"] == "radio"
    assert answer["song"] is None
    assert answer["radio"] == RADIO["radio"]
    assert answer["position"] is None


def test_a_reported_cast_says_where_it_plays():
    stored(at=NOW, devices=["Living room"])
    answer = now_playing.current(ALICE, now=NOW)
    assert answer["source"] == "cast"
    assert answer["devices"] == ["Living room"]


def test_a_cast_comes_before_a_browser(default_session, at_position):
    cast(default_session, song="cast", started=NOW - 100)
    stored("browser", at=NOW)
    assert now_playing.current(ALICE, now=NOW)["song"]["id"] == "cast"


def test_what_can_be_heard_comes_before_a_paused_cast(default_session, at_position):
    cast(default_session, song="cast", started=NOW - 100, paused=True)
    stored("browser", at=NOW)
    assert now_playing.current(ALICE, now=NOW)["song"]["id"] == "browser"


def test_a_reported_cast_comes_before_a_browser():
    stored("desktop", at=NOW - 50, source="key:a", devices=["Living room"])
    stored("browser", at=NOW, source="session:b")
    assert now_playing.current(ALICE, now=NOW)["song"]["id"] == "desktop"


def test_of_two_browsers_the_last_to_start_wins_whatever_the_heartbeats_say():
    stored("older", at=NOW, source="session:a")
    stored("newer", at=NOW + 5, source="session:b")
    stored("older", at=NOW + 10, source="session:a")
    assert now_playing.current(ALICE, now=NOW + 10)["song"]["id"] == "newer"


def test_a_browser_that_plays_comes_before_one_paused_later():
    stored("playing", at=NOW, source="session:a")
    stored("paused", at=NOW + 5, source="session:b", paused=True)
    assert now_playing.current(ALICE, now=NOW + 5)["song"]["id"] == "playing"


def test_a_new_song_counts_as_starting_again():
    stored("first", at=NOW, source="session:a")
    stored("other", at=NOW + 5, source="session:b")
    stored("second", at=NOW + 10, source="session:a")
    assert now_playing.current(ALICE, now=NOW + 10)["song"]["id"] == "second"


def test_a_cover_for_what_a_browser_plays(public, default_session):
    default_session.account_server_type = ALICE.server_type
    default_session.account_server_url = ALICE.server_url
    default_session.account_username = ALICE.username
    now_playing.store_report("session:a", ALICE, report())
    served = AsyncMock(return_value=Response(b"img", media_type="image/png"))
    with patch.object(device_link, "cover_image", served):
        response = public.get(
            "/device-link/v1/now-playing/cover", headers=auth(app_key("now_playing"))
        )
    assert response.content == b"img"
    served.assert_awaited_once_with(default_session.media, "cover-1")


def test_no_cover_for_a_reported_song_without_one(public, default_session):
    default_session.account_server_type = ALICE.server_type
    default_session.account_server_url = ALICE.server_url
    default_session.account_username = ALICE.username
    bare = report()
    bare["song"]["cover_art_id"] = ""
    now_playing.store_report("session:a", ALICE, bare)
    served = AsyncMock()
    with patch.object(device_link, "cover_image", served):
        response = public.get(
            "/device-link/v1/now-playing/cover", headers=auth(app_key("now_playing"))
        )
    assert response.status_code == 404
    served.assert_not_awaited()


def test_no_cover_with_no_session_to_reach_the_media_server(public):
    now_playing.store_report("key:a", ALICE, report())
    response = public.get("/device-link/v1/now-playing/cover", headers=auth(app_key("now_playing")))
    assert response.status_code == 404


def test_a_paired_desktop_passes_its_report_on(paired, client, signed_in):
    assert client.post("/now-playing/report", json=report()).json() == {"wanted": True}
    assert paired.reported[-1]["song"]["id"] == "s1"
    assert now_playing._reports == {}


def test_a_paired_desktop_hears_when_nobody_wants_it(paired, client, signed_in):
    paired.wants_now_playing = False
    assert client.post("/now-playing/report", json=report()).json() == {"wanted": False}


def test_a_paired_desktop_takes_its_report_back(paired, client, signed_in):
    client.delete("/now-playing/report")
    assert paired.reported == [None]


def test_a_paired_desktop_with_the_server_away_is_not_held_up(paired, client, signed_in):
    paired.fail = httpx.ConnectError("away")
    assert client.post("/now-playing/report", json=report()).json() == {"wanted": False}


def test_the_server_keeps_what_a_desktop_passes_on(public):
    desktop, app = key_for(), app_key("now_playing")
    response = public.put("/device-link/now-playing", headers=auth(desktop), json=report())
    assert response.json() == {"wanted": True}
    assert playing(public, app).json()["song"]["id"] == "s1"


def test_the_server_refuses_it_with_no_app_to_show_it_to(public):
    response = public.put("/device-link/now-playing", headers=auth(key_for()), json=report())
    assert response.json() == {"wanted": False}
    assert now_playing._reports == {}


def test_a_desktop_can_take_it_back_on_the_server(public):
    desktop, app = key_for(), app_key("now_playing")
    public.put("/device-link/now-playing", headers=auth(desktop), json=report())
    public.delete("/device-link/now-playing", headers=auth(desktop))
    assert playing(public, app).json() == {"playing": False}


def test_an_app_cannot_report_anything(public):
    key = app_key("now_playing")
    assert (
        public.put("/device-link/now-playing", headers=auth(key), json=report()).status_code == 403
    )
    assert public.delete("/device-link/now-playing", headers=auth(key)).status_code == 403


def test_a_report_that_is_far_too_big_is_refused(public):
    body = report()
    body["devices"] = ["x" * 2000] * 16
    response = public.put("/device-link/now-playing", headers=auth(key_for()), json=body)
    assert response.status_code == 413


# ── lyrics of what is playing ────────────────────────────────────────────


SHEET = {
    "synced": True,
    "lines": [{"time": 1.5, "text": "First", "extra": "x"}, {"time": 3.0, "text": "Second"}],
}


def lyrics(public, key=None):
    return public.get(
        "/device-link/v1/now-playing/lyrics",
        headers=auth(key or app_key("now_playing", "lyrics")),
    )


@pytest.fixture
def sheet():
    with patch.object(device_link, "auto_for_party", AsyncMock(return_value=SHEET)) as found:
        yield found


def test_lyrics_of_the_song_playing_now(public, default_session, at_position, sheet):
    cast(default_session)
    assert lyrics(public).json() == {
        "song_id": "s1",
        "synced": True,
        "lines": [{"time": 1.5, "text": "First"}, {"time": 3.0, "text": "Second"}],
        "offset": 0.0,
    }
    asked = sheet.await_args.args[0]
    assert (asked["title"], asked["artist"], asked["album"]) == ("Song", "Artist", "Album")


def test_lyrics_come_with_the_accounts_correction(public, default_session, at_position, sheet):
    cast(default_session)
    lyrics_offsets.save(ALICE, {"s1": -0.7, "other": 9.0})
    assert lyrics(public).json()["offset"] == -0.7


def test_a_correction_of_another_account_does_not_count(
    public, default_session, at_position, sheet
):
    cast(default_session)
    lyrics_offsets.save(BOB, {"s1": 5.0})
    assert lyrics(public).json()["offset"] == 0.0


def test_lyrics_work_for_what_a_window_reports(public, sheet):
    now_playing.store_report("session:a", ALICE, report())
    assert lyrics(public).json()["song_id"] == "s1"


def test_a_song_without_lyrics_says_so(public, default_session, at_position):
    cast(default_session)
    with patch.object(device_link, "auto_for_party", AsyncMock(return_value=None)):
        answer = lyrics(public).json()
    assert answer == {"song_id": "s1", "synced": False, "lines": [], "offset": 0.0}


def test_unsynced_lyrics_say_so(public, default_session, at_position):
    cast(default_session)
    plain = {"synced": False, "lines": [{"time": 0.0, "text": "Line"}]}
    with patch.object(device_link, "auto_for_party", AsyncMock(return_value=plain)):
        answer = lyrics(public).json()
    assert answer["synced"] is False
    assert answer["lines"] == [{"time": 0.0, "text": "Line"}]


def test_a_failing_provider_reads_as_no_lyrics(public, default_session, at_position):
    cast(default_session)
    with patch.object(device_link, "auto_for_party", AsyncMock(side_effect=RuntimeError)):
        response = lyrics(public)
    assert response.status_code == 200
    assert response.json()["lines"] == []


def test_no_lyrics_with_nothing_playing(public, sheet):
    assert lyrics(public).status_code == 404
    sheet.assert_not_awaited()


def test_no_lyrics_for_radio(public, sheet):
    now_playing.store_report("session:a", ALICE, {**report(), **RADIO})
    assert lyrics(public).status_code == 404
    sheet.assert_not_awaited()


def test_lyrics_need_their_own_right(public, default_session, at_position, sheet):
    cast(default_session)
    assert lyrics(public, app_key("now_playing")).status_code == 403
    assert lyrics(public, key_for()).status_code == 403
    assert public.get("/device-link/v1/now-playing/lyrics").status_code == 401
    sheet.assert_not_awaited()


# ── the published description ────────────────────────────────────────────


CONTRACT = Path(__file__).parent / "device_link_v1_contract.json"


def published(public) -> dict:
    return public.get("/device-link/v1/openapi.json").json()


def _shape(document: dict) -> dict:
    """What an existing app relies on: never the wording."""

    def without_words(value):
        if isinstance(value, dict):
            return {
                k: without_words(v) for k, v in value.items() if k not in ("description", "title")
            }
        return [without_words(v) for v in value] if isinstance(value, list) else value

    return {
        "paths": sorted(document["paths"]),
        "operations": {
            f"{method.upper()} {path}": {
                "parameters": {p["name"]: without_words(p) for p in operation["parameters"]},
                "body": without_words(operation.get("requestBody", {})),
                "responses": sorted(operation["responses"]),
            }
            for path, item in document["paths"].items()
            for method, operation in item.items()
        },
        "fields": {
            name: without_words(model["properties"])
            for name, model in document["components"]["schemas"].items()
            if "properties" in model and name not in ("HTTPValidationError", "ValidationError")
        },
    }


def test_the_description_is_readable_without_a_key(public):
    response = public.get("/device-link/v1/openapi.json")
    assert response.status_code == 200
    assert response.json()["openapi"].startswith("3.")


def test_a_page_anywhere_can_read_the_description(public):
    response = public.get("/device-link/v1/openapi.json", headers=ELSEWHERE)
    assert response.headers["access-control-allow-origin"] == "*"


def test_only_the_public_routes_are_described(public):
    assert all(path.startswith("/device-link/v1/") for path in published(public)["paths"])


def test_it_says_how_to_send_the_key_and_not_as_a_parameter(public):
    document = published(public)
    assert document["components"]["securitySchemes"]["deviceKey"]["name"] == server_link.KEY_HEADER
    assert document["security"] == [{"deviceKey": []}]
    assert not document["paths"]["/device-link/v1/stats"]["get"]["parameters"]


def test_each_route_describes_its_answer(public):
    paths = published(public)["paths"]
    for path, ref in (
        ("me", "Me"),
        ("history", "HistoryPage"),
        ("stats", "Stats"),
        ("now-playing/lyrics", "Lyrics"),
    ):
        answer = paths[f"/device-link/v1/{path}"]["get"]["responses"]["200"]
        assert answer["content"]["application/json"]["schema"]["$ref"].endswith(f"/{ref}")


def test_every_route_says_what_it_is_for(public):
    for path, item in published(public)["paths"].items():
        for method, operation in item.items():
            assert operation.get("description"), f"{method.upper()} {path}"


def test_v1_only_ever_grows(public):
    """A failure here means an app somebody wrote stops working. If that is
    really what is wanted, it is a v2, not an edit to this file."""
    now = _shape(published(public))
    promised = json.loads(CONTRACT.read_text())
    assert set(promised["paths"]) <= set(now["paths"])
    for model, fields in promised["fields"].items():
        assert model in now["fields"], model
        for field, shape in fields.items():
            assert now["fields"][model].get(field) == shape, f"{model}.{field}"
    for path, operation in promised["operations"].items():
        parameters = now["operations"][path]["parameters"]
        for name, parameter in operation["parameters"].items():
            assert parameters.get(name) == parameter, f"{path} {name}"
        for name in parameters.keys() - operation["parameters"].keys():
            assert not parameters[name].get("required"), f"{path} {name} is new and required"
        assert operation["body"] == now["operations"][path]["body"], path
        assert set(operation["responses"]) <= set(now["operations"][path]["responses"]), path


def test_answers_match_what_is_described(public, default_session, at_position, sheet):
    cast(default_session)
    delivered(row("a" * 32, NOW - 10, album="B", genre="Rock"))
    key = app_key("history", "stats", "now_playing", "lyrics")
    assert public.get("/device-link/v1/me", headers=auth(key)).status_code == 200
    for path in ("history", "stats", "now-playing", "now-playing/lyrics"):
        assert public.get(f"/device-link/v1/{path}", headers=auth(key)).status_code == 200, path


# ── the library and the login it is browsed with ────────────────────────────


SUBSONIC_LOGIN = {
    "server_type": "subsonic",
    "url": "https://music.example",
    "credential": "u=alice&t=0123456789abcdef&s=salty",
}


def library_key(login: dict | None = None) -> str:
    return device_keys.create(
        ALICE,
        "Home Assistant",
        ALICE_SETTINGS,
        scopes=("control", "library"),
        login=login or SUBSONIC_LOGIN,
    )["key"]


def stored_login(key: str) -> bytes | None:
    key_id = key.partition(".")[0]
    with play_history.transaction() as conn:
        return conn.execute(
            "SELECT media_login FROM device_keys WHERE id = ?", (key_id,)
        ).fetchone()["media_login"]


def test_a_library_key_takes_the_login_of_the_session_that_made_it(client, on_server):
    on_server.media = SubsonicClient(
        "https://music.example", credential=SUBSONIC_LOGIN["credential"]
    )
    made = client.post(
        "/device-keys", json={"label": "Home Assistant", "scopes": ["control", "library"]}
    ).json()
    assert device_keys.media_login_of(made["key"]) == SUBSONIC_LOGIN


def test_the_login_is_never_stored_readable():
    sealed = stored_login(library_key())
    assert b"0123456789abcdef" not in sealed
    assert b"music.example" not in sealed


def test_a_key_without_the_library_keeps_no_login():
    key = device_keys.create(
        ALICE, "Display", ALICE_SETTINGS, scopes=("control",), login=SUBSONIC_LOGIN
    )["key"]
    assert stored_login(key) is None


def test_the_library_right_needs_a_login():
    with pytest.raises(device_keys.MissingMediaLogin):
        device_keys.create(ALICE, "HA", ALICE_SETTINGS, scopes=("control", "library"))


def test_only_its_own_key_opens_the_login():
    key = library_key()
    key_id = key.partition(".")[0]
    other = library_key().partition(".")[2]
    assert device_keys.media_login_of(key) == SUBSONIC_LOGIN
    assert device_keys.media_login_of(f"{key_id}.{other}") is None
    assert device_keys.media_login_of(f"{key_id}.wrong") is None


def test_a_sealed_login_moved_to_another_key_does_not_open():
    first, second = library_key(), library_key()
    moved = stored_login(first)
    with play_history.transaction() as conn:
        conn.execute(
            "UPDATE device_keys SET media_login = ? WHERE id = ?",
            (moved, second.partition(".")[0]),
        )
    assert device_keys.media_login_of(second) is None


@pytest.mark.parametrize(
    "login, kind",
    [
        (SUBSONIC_LOGIN, SubsonicClient),
        (
            {
                "server_type": "jellyfin",
                "url": "https://jf.example",
                "credential": "jf-token",
                "user_id": "u-1",
            },
            JellyfinClient,
        ),
        (
            {
                "server_type": "plex",
                "url": "https://plex.example",
                "credential": "plex-token",
                "machine_identifier": "m-1",
            },
            PlexClient,
        ),
    ],
)
def test_a_login_makes_the_same_client_again(login, kind):
    client = media_login.client_for(login)
    assert isinstance(client, kind)
    assert media_login.capture(client) == login


@pytest.fixture
def media_server(monkeypatch):
    """Answers Subsonic calls by endpoint and records the login they came with."""
    answers: dict = {}
    seen: list[str] = []

    def fake_get(self, endpoint, **params):
        seen.append(self._credential)
        answer = answers[endpoint]
        if isinstance(answer, Exception):
            raise answer
        return answer(params) if callable(answer) else answer

    monkeypatch.setattr(SubsonicClient, "_get", fake_get)
    device_link._library_clients.clear()
    return SimpleNamespace(answers=answers, seen=seen)


LIBRARY_PATHS = (
    "/device-link/v1/library/songs?search=harbor",
    "/device-link/v1/library/albums",
    "/device-link/v1/library/albums/al-1",
    "/device-link/v1/library/playlists",
    "/device-link/v1/library/playlists/pl-1",
    "/device-link/v1/library/radio-stations",
    "/device-link/v1/library/radio-stations/st-1/logo",
    "/device-link/v1/library/cover/al-1",
)


@pytest.mark.parametrize("path", LIBRARY_PATHS)
def test_the_library_needs_its_right(public, path):
    key = device_keys.create(ALICE, "Display", ALICE_SETTINGS, scopes=("control",))["key"]
    assert public.get(path, headers=auth(key)).status_code == 403


def test_playlists_come_from_the_media_server_with_the_keys_login(public, media_server):
    media_server.answers["getPlaylists.view"] = {
        "playlists": {"playlist": [{"id": "pl-1", "name": "Road", "songCount": 3}]}
    }
    response = public.get("/device-link/v1/library/playlists", headers=auth(library_key()))
    assert response.json() == {
        "items": [{"id": "pl-1", "name": "Road", "song_count": 3, "cover_art_id": None}]
    }
    assert media_server.seen == [SUBSONIC_LOGIN["credential"]]


def test_a_playlist_comes_with_its_songs_in_order(public, media_server):
    media_server.answers["getPlaylist.view"] = {
        "playlist": {
            "id": "pl-1",
            "name": "Road",
            "songCount": 2,
            "entry": [{"id": "s2", "title": "B"}, {"id": "s1", "title": "A"}],
        }
    }
    answer = public.get(
        "/device-link/v1/library/playlists/pl-1", headers=auth(library_key())
    ).json()
    assert [song["id"] for song in answer["songs"]] == ["s2", "s1"]


def test_albums_without_a_search_are_listed_by_name_page_by_page(public, media_server):
    asked = []

    def album_list(params):
        asked.append(params)
        return {"albumList2": {"album": [{"id": "al-1", "name": "Low"}]}}

    media_server.answers["getAlbumList2.view"] = album_list
    public.get("/device-link/v1/library/albums?offset=50&limit=25", headers=auth(library_key()))
    assert asked == [{"type": "alphabeticalByName", "size": "25", "offset": "50"}]


def test_an_unknown_playlist_is_a_404(public, media_server):
    media_server.answers["getPlaylist.view"] = {}
    response = public.get("/device-link/v1/library/playlists/x", headers=auth(library_key()))
    assert response.status_code == 404


def test_a_login_the_media_server_refuses_says_so(public, media_server):
    media_server.answers["getPlaylists.view"] = SubsonicError(40, "Wrong username or password")
    response = public.get("/device-link/v1/library/playlists", headers=auth(library_key()))
    assert response.status_code == 409
    assert response.json()["detail"] == "media_login_rejected"


def test_a_media_server_that_does_not_answer_is_not_the_keys_fault(public, media_server):
    media_server.answers["getPlaylists.view"] = httpx.ConnectError("refused")
    response = public.get("/device-link/v1/library/playlists", headers=auth(library_key()))
    assert response.status_code == 502


def test_a_new_login_is_not_answered_with_an_old_client(public, media_server):
    media_server.answers["getPlaylists.view"] = {"playlists": {}}
    other = {**SUBSONIC_LOGIN, "credential": "u=alice&t=new&s=new"}
    public.get("/device-link/v1/library/playlists", headers=auth(library_key()))
    public.get("/device-link/v1/library/playlists", headers=auth(library_key(other)))
    assert media_server.seen == [SUBSONIC_LOGIN["credential"], other["credential"]]


# ── the player ───────────────────────────────────────────────────────────

PLAYER = "/device-link/v1/player"
COMMANDS = "/device-link/v1/player/commands"


@pytest.fixture
def as_server(monkeypatch):
    monkeypatch.setattr(server_link, "AVAILABLE", False)
    player_server._key_sessions.clear()
    player_server._titles.clear()
    player_server._admin_checked.clear()


def control_key(account=ALICE) -> str:
    return device_keys.create(account, "Home Assistant", ALICE_SETTINGS, scopes=("control",))["key"]


def send(public, key, **command):
    return public.post(COMMANDS, headers=auth(key), json=command)


@pytest.fixture
def handlers(monkeypatch):
    """The playback handlers a server player calls, standing in for speakers."""
    calls = SimpleNamespace(
        pause=AsyncMock(return_value={"status": "paused"}),
        resume=AsyncMock(return_value={"status": "resumed"}),
        seek=AsyncMock(return_value={"status": "ok"}),
        queue=AsyncMock(return_value={"status": "ok"}),
        play=AsyncMock(return_value={"status": "playing"}),
        play_url=AsyncMock(return_value={"status": "playing"}),
        jump=AsyncMock(return_value=True),
        volume=AsyncMock(return_value={"status": "ok"}),
        join=AsyncMock(return_value={"status": "ok"}),
        stop_device=AsyncMock(return_value={"status": "ok"}),
    )
    monkeypatch.setattr(playback, "pause_session", calls.pause)
    monkeypatch.setattr(playback, "resume_playback", calls.resume)
    monkeypatch.setattr(playback, "seek_playback", calls.seek)
    monkeypatch.setattr(playback, "update_queue", calls.queue)
    monkeypatch.setattr(playback, "play_tracks", calls.play)
    monkeypatch.setattr(playback, "play_url", calls.play_url)
    monkeypatch.setattr(stream, "jump_to", calls.jump)
    monkeypatch.setattr(player_server, "set_device_volume", calls.volume)
    monkeypatch.setattr(player_server, "join_stream", calls.join)
    monkeypatch.setattr(player_server, "stop_device", calls.stop_device)
    return calls


class SonosDelivery:
    """Named like the real one: the player reports the type from the class."""

    target = "Living room"


def queued_cast(session, queue=("s0", "s1", "s2"), index=1, **kwargs):
    cast(session, song=queue[index], **kwargs)
    session.state.active_delivery = SonosDelivery()
    session.state.queue = list(queue)
    session.state.queue_index = index
    session.state.original_queue = list(queue)
    return session


def test_the_player_needs_the_control_right(public, as_server):
    assert public.get(PLAYER, headers=auth(app_key())).status_code == 403
    assert send(public, app_key(), type="pause").status_code == 403


def test_a_server_with_nothing_cast_is_idle_but_can_start_with_the_library(public, as_server):
    assert public.get(PLAYER, headers=auth(control_key())).json()["commands"] == []
    answer = public.get(PLAYER, headers=auth(library_key())).json()
    assert answer["available"] is True
    assert answer["state"] == "idle"
    assert "play_album" in answer["commands"]


def test_another_accounts_cast_is_not_this_keys_player(public, as_server, default_session):
    cast(default_session, account=BOB)
    assert public.get(PLAYER, headers=auth(control_key())).json()["state"] == "idle"
    assert send(public, control_key(), type="pause").status_code == 409


def test_a_cast_is_the_servers_player(public, as_server, default_session):
    queued_cast(default_session)
    with patch.object(player_server, "compute_position", return_value=12.5):
        answer = public.get(PLAYER, headers=auth(control_key())).json()
    assert answer["state"] == "playing"
    assert answer["source"] == "cast"
    assert answer["song"]["id"] == "s1"
    assert answer["position"] == 12.5
    assert answer["queue_index"] == 1
    assert [song["id"] for song in answer["queue"]] == ["s0", "s1", "s2"]
    assert answer["queue"][1]["title"] == "Song"
    assert answer["devices"] == [{"type": "sonos", "name": "Living room"}]


def test_pause_and_play_act_on_the_cast(public, as_server, default_session, handlers):
    queued_cast(default_session)
    key = control_key()
    assert send(public, key, type="pause").status_code == 200
    handlers.pause.assert_awaited_once()
    assert handlers.pause.await_args.args[0] is default_session
    send(public, key, type="play")
    handlers.resume.assert_not_awaited()  # already playing
    default_session.state.clock.is_paused = True
    send(public, key, type="play")
    handlers.resume.assert_awaited_once()


def test_nothing_cast_means_nothing_to_steer(public, as_server, handlers):
    assert send(public, control_key(), type="pause").status_code == 409
    handlers.pause.assert_not_awaited()


def test_a_station_takes_only_what_a_station_can_do(public, as_server, default_session, handlers):
    queued_cast(default_session)
    default_session.state.current_track = None
    default_session.state.radio_info = {"title": "Station", "url": "http://radio.example"}
    key = control_key()
    answer = public.get(PLAYER, headers=auth(key)).json()
    assert answer["radio"]["station"] == "Station"
    assert "next" not in answer["commands"]
    assert send(public, key, type="shuffle", on=True).status_code == 409
    handlers.queue.assert_not_awaited()


def test_previous_restarts_a_song_well_under_way(public, as_server, default_session, handlers):
    queued_cast(default_session)
    with patch.object(player_server, "compute_position", return_value=40.0):
        send(public, control_key(), type="previous")
    assert handlers.seek.await_args.args[0].position == 0
    handlers.jump.assert_not_awaited()


def test_previous_goes_back_at_the_start_of_a_song(public, as_server, default_session, handlers):
    queued_cast(default_session)
    with patch.object(player_server, "compute_position", return_value=2.0):
        send(public, control_key(), type="previous")
    assert handlers.jump.await_args.args[:2] == (default_session, 0)


def test_volume_reaches_every_speaker_of_the_cast(public, as_server, default_session, handlers):
    queued_cast(default_session)
    send(public, control_key(), type="volume", volume=0.42)
    request = handlers.volume.await_args.args[2]
    assert request.volume == 42
    assert next(iter(default_session.state.device_volumes.values()))[0] == 42


def test_a_queue_change_from_an_app_beats_what_a_window_sent(
    public, as_server, default_session, handlers
):
    queued_cast(default_session)
    default_session.play_seq = int(time.time() * 1000) + 60_000
    send(public, control_key(), type="repeat", mode="all")
    request = handlers.queue.await_args.args[0]
    assert request.repeat_mode == "all"
    assert request.seq > default_session.play_seq
    assert request.song_ids == ["s0", "s1", "s2"]


def test_shuffle_keeps_the_song_playing_where_the_listener_is():
    queue, index = player_server.shuffled(
        ["a", "b", "c", "d"], ["a", "b", "c", "d"], 2, True, False
    )
    assert queue[index] == "c"
    assert sorted(queue) == ["a", "b", "c", "d"]
    back, at = player_server.shuffled(queue, ["a", "b", "c", "d"], index, False, False)
    assert (back, at) == (["a", "b", "c", "d"], 2)


def test_shuffle_keeps_a_song_the_mix_has_lined_up_next():
    for _ in range(20):
        queue, index = player_server.shuffled(list("abcdef"), list("abcdef"), 1, True, True)
        assert queue[index : index + 2] == ["b", "c"]


def test_starting_needs_the_library_right(public, as_server, handlers):
    response = send(public, control_key(), type="play_song", song_id="s1")
    assert response.status_code == 403
    handlers.play.assert_not_awaited()


def test_starting_with_nothing_cast_needs_a_speaker(public, as_server, handlers, media_server):
    response = send(public, library_key(), type="play_song", song_id="s1")
    assert response.status_code == 409
    assert response.json()["detail"] == "no_speaker"


def test_an_album_starts_on_the_named_speaker_with_the_keys_own_login(
    public, as_server, handlers, media_server
):
    media_server.answers["getAlbum.view"] = {
        "album": {"id": "al-1", "name": "A", "song": [{"id": "x1"}, {"id": "x2"}]}
    }
    key = library_key()
    response = send(
        public, key, type="play_album", album_id="al-1", devices=[{"type": "sonos", "name": "Den"}]
    )
    assert response.status_code == 200
    request, session = handlers.play.await_args.args
    assert request.song_ids == ["x1", "x2"]
    assert request.targets == [{"type": "sonos", "name": "Den"}]
    assert media_login.capture(session.media) == SUBSONIC_LOGIN
    account = (
        session.account_server_type,
        session.account_server_url,
        session.account_username,
    )
    assert account == ALICE
    assert session.authenticated
    # Not one anybody could guess and send as X-Connect-Session.
    assert len(session.session_id) > len(f"key-{key.partition('.')[0]}-") + 16
    send(public, key, type="play_song", song_id="x2", devices=[{"type": "sonos", "name": "Den"}])
    assert handlers.play.await_args.args[1] is session


def test_a_key_remembers_the_session_it_was_made_in(client, on_server):
    made = client.post("/device-keys", json={"label": "HA", "scopes": ["control"]}).json()
    assert device_keys.resolve(made["key"]).session_id == on_server.session_id


def account_key(session_id: str | None) -> str:
    return device_keys.create(
        ALICE,
        "Home Assistant",
        ALICE_SETTINGS,
        scopes=("control", "library"),
        login=SUBSONIC_LOGIN,
        session_id=session_id,
    )["key"]


DEN = [{"type": "sonos", "name": "Den"}]


def test_a_cast_a_key_starts_lands_in_the_accounts_own_session(
    public, as_server, handlers, media_server
):
    send(public, account_key("account-session"), type="play_song", song_id="s1", devices=DEN)
    assert handlers.play.await_args.args[1].session_id == "account-session"


def test_a_browser_signed_in_there_keeps_its_own_login(public, on_server, handlers, media_server):
    own_login = on_server.media
    send(public, account_key(on_server.session_id), type="play_song", song_id="s1", devices=DEN)
    session = handlers.play.await_args.args[1]
    assert session is on_server
    assert session.media is own_login


def test_a_key_older_than_that_takes_the_accounts_session_in_use(
    public, on_server, handlers, media_server
):
    send(public, account_key(None), type="play_song", song_id="s1", devices=DEN)
    assert handlers.play.await_args.args[1] is on_server


def test_a_key_never_takes_a_session_signed_in_as_somebody_else(
    public, as_server, default_session, handlers, media_server
):
    default_session.account_server_type, default_session.account_server_url = BOB[:2]
    default_session.account_username = BOB.username
    send(
        public, account_key(default_session.session_id), type="play_song", song_id="s1", devices=DEN
    )
    session = handlers.play.await_args.args[1]
    assert session is not default_session
    assert default_session.account_username == BOB.username


def test_starting_while_something_is_cast_plays_on_that_cast(
    public, as_server, default_session, handlers, media_server
):
    queued_cast(default_session)
    send(public, library_key(), type="play_song", song_id="x9")
    request, session = handlers.play.await_args.args
    assert session is default_session
    assert request.song_ids == ["x9"]
    assert request.targets == [{"type": "sonos", "name": "Living room"}]


def test_a_speaker_somebody_else_uses_is_not_taken_over(public, as_server, handlers, media_server):
    handlers.play.return_value = {"error": "device_in_use", "in_use_by": "Bob"}
    response = send(
        public,
        library_key(),
        type="play_song",
        song_id="s1",
        devices=[{"type": "sonos", "name": "Den"}],
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "device_in_use"
    assert handlers.play.await_args.args[0].force is False


def test_play_next_comes_after_what_the_mix_has_lined_up(
    public, as_server, default_session, handlers, media_server
):
    queued_cast(default_session)
    send(public, library_key(), type="queue_next", song_id="new")
    assert handlers.queue.await_args.args[0].song_ids == ["s0", "s1", "new", "s2"]
    default_session.state.mix = object()
    send(public, library_key(), type="queue_next", song_id="new")
    assert handlers.queue.await_args.args[0].song_ids == ["s0", "s1", "s2", "new"]
    send(public, library_key(), type="queue_add", song_id="last")
    assert handlers.queue.await_args.args[0].song_ids[-1] == "last"


def test_moving_a_cast_joins_before_it_lets_go(public, as_server, default_session, handlers):
    queued_cast(default_session)
    order = []
    handlers.join.side_effect = lambda *a, **k: order.append("join") or {"status": "ok"}
    handlers.stop_device.side_effect = lambda *a, **k: order.append("stop") or {"status": "ok"}
    send(public, control_key(), type="devices", devices=[{"type": "sonos", "name": "Den"}])
    assert handlers.join.await_args.args[0].target_name == "Den"
    assert handlers.stop_device.await_args.args[:2] == ("sonos", "Living room")
    assert order == ["join", "stop"]


def test_the_device_list_says_who_holds_a_speaker(public, as_server, default_session):
    from core.state import ctx

    ctx.discovered = {"sonos": [{"name": "Den"}], "airplay": [], "chromecast": [], "dlna": []}
    default_session.display_name = "Bob"
    asyncio.run(claims.claim("sonos", "Den", default_session.session_id))
    answer = public.get("/device-link/v1/player/devices", headers=auth(control_key())).json()
    assert answer["items"] == [
        {"type": "sonos", "name": "Den", "in_use_by": "Bob", "needs_pairing": False}
    ]


@pytest.fixture
def admins_only(monkeypatch):
    """Cast permissions as a server may set them: nobody but admins casts."""
    from core import cast_permissions

    monkeypatch.setattr(cast_permissions, "policy", lambda *_: ("blocklist", False))


def admin_answer(admin: bool):
    return {"user": {"username": "alice", "adminRole": admin}}


@pytest.mark.parametrize("admin", [True, False])
def test_where_only_admins_cast_the_device_list_asks_the_media_server(
    public, as_server, media_server, admins_only, admin
):
    from core.state import ctx

    ctx.discovered = {"sonos": [{"name": "Den"}], "airplay": [], "chromecast": [], "dlna": []}
    media_server.answers["getUser.view"] = admin_answer(admin)
    answer = public.get("/device-link/v1/player/devices", headers=auth(library_key())).json()
    assert [d["name"] for d in answer["items"]] == (["Den"] if admin else [])


def test_a_key_without_a_login_is_no_admin(public, as_server, admins_only):
    from core.state import ctx

    ctx.discovered = {"sonos": [{"name": "Den"}], "airplay": [], "chromecast": [], "dlna": []}
    answer = public.get("/device-link/v1/player/devices", headers=auth(control_key())).json()
    assert answer["items"] == []


@pytest.mark.parametrize("admin", [True, False])
def test_a_cast_started_from_a_key_carries_the_admin_role(
    public, as_server, handlers, media_server, admin
):
    media_server.answers["getUser.view"] = admin_answer(admin)
    send(
        public,
        library_key(),
        type="play_song",
        song_id="s1",
        devices=[{"type": "sonos", "name": "Den"}],
    )
    assert handlers.play.await_args.args[1].account_is_admin is admin


def test_the_admin_role_is_asked_again_after_a_while(public, as_server, media_server):
    media_server.answers["getUser.view"] = admin_answer(True)
    key = library_key()
    public.get("/device-link/v1/player/devices", headers=auth(key))
    public.get("/device-link/v1/player/devices", headers=auth(key))
    assert media_server.seen.count(SUBSONIC_LOGIN["credential"]) == 1
    media_server.answers["getUser.view"] = admin_answer(False)
    key_id = key.partition(".")[0]
    checked_at, admin = player_server._admin_checked[key_id]
    player_server._admin_checked[key_id] = (checked_at - player_server._ADMIN_TTL_SECONDS, admin)
    public.get("/device-link/v1/player/devices", headers=auth(key))
    assert player_server._admin_checked[key_id][1] is False


# On the desktop app


def window(session, account=ALICE, **snapshot):
    session.account_server_type, session.account_server_url, session.account_username = account
    remote.renderer_connected = True
    remote.snapshot = {"session_id": session.session_id, **snapshot}
    remote.snapshot_at = time.time()


def test_a_window_signed_in_as_somebody_else_is_not_there(public, default_session):
    window(default_session, account=BOB, playing=True, current_song={"id": "s1"})
    assert public.get(PLAYER, headers=auth(control_key())).json()["available"] is False
    assert send(public, control_key(), type="pause").status_code == 409


def test_the_windows_position_is_carried_forward_while_it_plays(public, default_session):
    window(default_session, playing=True, current_song={"id": "s1"}, position=10.0)
    remote.snapshot_at = time.time() - 5
    answer = public.get(PLAYER, headers=auth(control_key())).json()
    assert 14.9 < answer["position"] < 16


def test_the_window_is_told_only_what_changes(public, default_session):
    window(default_session, playing=True, current_song={"id": "s1"}, shuffle=True, repeat="off")
    with patch.object(player_desktop, "relay_command", AsyncMock()) as relayed:
        send(public, control_key(), type="shuffle", on=True)
        relayed.assert_not_awaited()
        send(public, control_key(), type="repeat", mode="one")
    assert [c.args[0] for c in relayed.await_args_list] == ["repeat", "repeat"]


def test_a_control_key_keeps_the_desktop_windows_relay_running(client, public):
    assert client.get("/remote/status").json()["integration"] is False
    app_key("now_playing")
    assert client.get("/remote/status").json()["integration"] is False
    key = control_key()
    assert client.get("/remote/status").json()["integration"] is True
    device_keys.revoke(ALICE, key.partition(".")[0])
    assert client.get("/remote/status").json()["integration"] is False


def test_a_server_has_no_window_to_keep_running(client, as_server):
    control_key()
    assert client.get("/remote/status").json()["integration"] is False


def test_covers_do_not_use_up_what_an_app_may_ask(public, media_server):
    key = library_key()
    with patch.object(device_link, "cover_image", AsyncMock(return_value=Response(b"img"))):
        for _ in range(device_link._V1_REQUESTS_PER_KEY[0] + 1):
            assert (
                public.get("/device-link/v1/library/cover/c1", headers=auth(key)).status_code == 200
            )
    media_server.answers["getPlaylists.view"] = {"playlists": {}}
    assert public.get("/device-link/v1/library/playlists", headers=auth(key)).status_code == 200


def test_the_player_stream_follows_a_song_that_plays_on(quick_stream, as_server, default_session):
    queued_cast(default_session)
    key = control_key()
    owner = device_keys.resolve(key)
    stream = device_link._player_events(key, owner)

    async def run():
        with patch.object(player_server, "compute_position", return_value=10.0) as position:
            await _drain(stream, 2)
            # Time passing is not news; a seek is, and the stream outlives both.
            position.return_value = 60.0
            seek = await asyncio.wait_for(anext(stream), 5)
            default_session.state.clock.is_paused = True
            pause = await asyncio.wait_for(anext(stream), 5)
        await stream.aclose()
        return seek, pause

    seek, pause = asyncio.run(run())
    assert json.loads(seek.removeprefix("data: "))["position"] == 60.0
    assert json.loads(pause.removeprefix("data: "))["state"] == "paused"


def test_a_player_stream_hears_nothing_while_the_song_just_plays():
    shown = {"state": "playing", "song": {"id": "s1"}, "position": 10.0, "at": 1000.0}
    later = {**shown, "position": 15.0, "at": 1005.0}
    assert not now_playing.differs(shown, later, paused=device_link._player_paused)
    paused = {**shown, "state": "paused"}
    assert not now_playing.differs(
        paused, {**paused, "at": 1100.0}, paused=device_link._player_paused
    )


def test_a_party_on_the_desktop_says_what_guests_hear(public, default_session):
    party = {"running": True, "guests": 3, "listeners": 2, "listen_kbps": 128}
    window(default_session, playing=True, current_song={"id": "s1"}, party=party)
    answer = public.get(PLAYER, headers=auth(control_key())).json()
    assert answer["party"] == party


def test_a_servers_station_shows_its_logo(public, as_server, default_session, media_server):
    queued_cast(default_session)
    default_session.state.current_track = None
    default_session.state.radio_info = {"title": "Eins", "url": "http://radio.example/live"}
    media_server.answers["getInternetRadioStations.view"] = {
        "internetRadioStations": {
            "internetRadioStation": [
                {"id": "r1", "name": "Other", "streamUrl": "http://other.example"},
                {
                    "id": "r2",
                    "name": "Renamed",
                    "streamUrl": "http://radio.example/live",
                    "homePageUrl": "https://eins.example",
                },
            ]
        }
    }
    logo = AsyncMock(return_value=Response(b"png", media_type="image/png"))
    with patch.object(player_server, "radio_favicon", logo):
        response = public.get("/device-link/v1/player/cover", headers=auth(control_key()))
    assert response.status_code == 200
    assert logo.await_args.kwargs["url"] == "https://eins.example"


def test_revoking_lets_go_of_the_keys_login(client, public, on_server, handlers, media_server):
    key = library_key()
    key_id = key.partition(".")[0]
    # No browser of the account has a login there, so the key needs its own session.
    on_server.media = None
    send(public, key, type="play_song", song_id="s1", devices=[{"type": "sonos", "name": "Den"}])
    assert key_id in device_link._library_clients
    assert key_id in player_server._key_sessions
    client.delete(f"/device-keys/{key_id}")
    assert key_id not in device_link._library_clients
    assert key_id not in player_server._key_sessions


def test_the_desktop_does_not_take_over_a_speaker_somebody_else_holds(public, default_session):
    window(default_session, playing=True, current_song={"id": "s1"})
    asyncio.run(claims.claim("sonos", "Den", "somebody-else"))
    with patch.object(player_desktop, "relay_command", AsyncMock()) as relayed:
        response = send(
            public, control_key(), type="devices", devices=[{"type": "sonos", "name": "Den"}]
        )
    assert response.status_code == 409
    assert response.json()["detail"] == "device_in_use"
    relayed.assert_not_awaited()


def test_the_desktop_keeps_a_speaker_its_own_window_holds(public, default_session):
    window(default_session, playing=True, current_song={"id": "s1"})
    asyncio.run(claims.claim("sonos", "Den", default_session.session_id))
    with patch.object(player_desktop, "relay_command", AsyncMock()) as relayed:
        response = send(
            public,
            control_key(),
            type="devices",
            devices=[{"type": "sonos", "name": "Den"}, {"type": "dlna", "name": "Hall"}],
        )
    assert response.status_code == 200
    assert relayed.await_args.args[0] == "cast-to-many"


def test_volume_reaches_every_speaker_the_window_casts_to(public, default_session):
    casting = [{"type": "sonos", "name": "Den"}, {"type": "dlna", "name": "Hall"}]
    window(default_session, playing=True, current_song={"id": "s1"}, casting=casting)
    with patch.object(player_desktop, "relay_command", AsyncMock()) as relayed:
        send(public, control_key(), type="volume", volume=0.4)
    assert [c.args for c in relayed.await_args_list] == [
        ("set-device-volume", {"deviceType": "sonos", "name": "Den", "volume": 40}),
        ("set-device-volume", {"deviceType": "dlna", "name": "Hall", "volume": 40}),
    ]
