"""Tests for party mode (core/party.py + routes/party.py).

/party/ is meant to be reachable without any login in front of it, so most
of what is here is the security boundary: which credential opens what, what
a guest can and cannot make the renderer do, and what never leaves connect.
The relay to the renderer is replaced by recorders - its own mechanics are
covered in test_remote.py.
"""

import asyncio
import re
import time

import pytest
from fastapi import Response
from fastapi.testclient import TestClient

import routes.coverart as coverart_module
import routes.lyrics as lyrics_routes
import routes.party as party_routes
from core import fanart as fanart_module
from core import integration_key
from core.party import Settings, clean_name, party
from core.remote import KEEPALIVE_TIMEOUT, remote
from core.session import build_status_dict
from delivery.base import BaseDelivery
from main import app
from media import SubsonicClient
from media.base import Track

ORIGIN = "http://testserver"


@pytest.fixture(autouse=True)
def built_page(tmp_path, monkeypatch):
    """What `pnpm build:party` leaves in static/party/ - the suite does not
    depend on a frontend build having run."""
    page = tmp_path / "party"
    (page / "assets").mkdir(parents=True)
    (page / "index.html").write_text(
        '<!doctype html><meta name="csp-nonce" content="__CSP_NONCE__"><title>Beacon Party</title>'
    )
    (page / "assets" / "index-abc.js").write_text("console.log(1)")
    monkeypatch.setattr(party_routes, "party_static", lambda: page)
    return page


@pytest.fixture
def guest_client():
    """A browser with no CONNECT_TOKEN - what a guest actually is."""
    with TestClient(app, raise_server_exceptions=False) as c:
        c.headers.update({"Origin": ORIGIN})
        yield c


@pytest.fixture
def relay(monkeypatch):
    """Records what would have been sent to the renderer."""
    sent = {"commands": [], "queries": []}
    answers = {}

    async def fake_command(command_type, payload):
        sent["commands"].append((command_type, payload))
        error = answers.get(command_type)
        if error:
            from fastapi import HTTPException

            raise HTTPException(status_code=502, detail=error)

    async def fake_query(query_type, payload):
        sent["queries"].append((query_type, payload))
        return answers.get(query_type, {"items": [], "total": 0})

    monkeypatch.setattr(party_routes, "relay_command", fake_command)
    monkeypatch.setattr(party_routes, "relay_query", fake_query)
    sent["answers"] = answers
    return sent


def _start(client, **body) -> str:
    resp = client.post("/party-host/enable", json=body)
    assert resp.status_code == 200
    return resp.json()["token"]


def _join(guest_client, token, name="Anna"):
    return guest_client.post("/party/api/join", json={"token": token, "name": name})


def _snapshot(queue_ids, index=0, requests=None, session_id=None, cover=True):
    songs = [
        {
            "id": song_id,
            "title": f"Title {song_id}",
            "artist": "Artist",
            "album": "Album",
            "duration": 200,
            "cover_art_id": f"cov-{song_id}" if cover else None,
            "cover_art_url": f"/remote/cover-art?id=cov-{song_id}&session=secret-session",
        }
        for song_id in queue_ids
    ]
    return {
        "playing": True,
        "volume": 0.7,
        "casting": [{"name": "Living room"}],
        "session_id": session_id or "host-session",
        "stream_info": {"target": "x"},
        "current_song": songs[index] if songs else None,
        "radio": None,
        "queue": songs,
        "queue_index": index,
        "party_requests": requests or {},
    }


# ── Credentials ─────────────────────────────────────────────────────────────


def test_everything_is_404_while_no_party_runs(guest_client):
    assert guest_client.get("/party/").status_code == 404
    assert guest_client.get("/party/api/state").status_code == 404
    assert _join(guest_client, "anything").status_code == 404


def test_host_endpoints_require_connect_token(guest_client):
    assert guest_client.post("/party-host/enable").status_code == 401
    assert guest_client.get("/party-host/status").status_code == 401


def test_join_sets_an_httponly_strict_cookie_scoped_to_party(client, guest_client):
    token = _start(client)
    resp = _join(guest_client, token)
    assert resp.status_code == 200
    cookie = resp.headers["set-cookie"].lower()
    assert "beacon_party=" in cookie
    assert "httponly" in cookie
    assert "samesite=strict" in cookie
    assert "path=/party" in cookie
    # Plain http in the test client: no Secure flag, or the browser would drop it.
    assert "secure" not in cookie
    assert guest_client.get("/party/api/state").status_code == 200


def test_cookie_is_secure_behind_a_trusted_https_proxy(client, guest_client):
    token = _start(client)
    # TestClient's peer is "testclient", not a trusted proxy - so pretend.
    party_routes_trusted = party_routes.is_trusted_proxy
    try:
        party_routes.is_trusted_proxy = lambda ip: True
        resp = guest_client.post(
            "/party/api/join",
            json={"token": token, "name": "Anna"},
            headers={"X-Forwarded-Proto": "https"},
        )
    finally:
        party_routes.is_trusted_proxy = party_routes_trusted
    assert "secure" in resp.headers["set-cookie"].lower()


def test_forwarded_proto_from_an_untrusted_peer_is_ignored(client, guest_client):
    token = _start(client)
    resp = guest_client.post(
        "/party/api/join",
        json={"token": token, "name": "Anna"},
        headers={"X-Forwarded-Proto": "https"},
    )
    assert "secure" not in resp.headers["set-cookie"].lower()


def test_wrong_token_is_refused(client, guest_client):
    _start(client)
    assert _join(guest_client, "wrong").status_code == 401


def test_the_invite_token_is_not_a_bearer_credential(client, guest_client):
    token = _start(client)
    resp = guest_client.get(f"/party/api/state?token={token}", headers={"X-Party-Token": token})
    assert resp.status_code == 401


def test_other_credentials_open_nothing_under_party(client, guest_client):
    _start(client)
    remote_password, _ = remote.enable()
    key = integration_key.generate()
    try:
        for headers in (
            {"X-Remote-Password": remote_password},
            {"X-Remote-Password": key},
            {"X-Connect-Token": client.headers.get("X-Connect-Token", "")},
        ):
            assert guest_client.get("/party/api/state", headers=headers).status_code == 401
    finally:
        integration_key.revoke()


def test_the_party_cookie_opens_nothing_outside_party(client, guest_client):
    token = _start(client)
    sid = _join(guest_client, token).cookies.get("beacon_party")
    assert sid
    remote.enable()
    # The cookie is scoped to /party, so a browser would not even send it
    # elsewhere - sent anyway here, it still must not count.
    guest_client.cookies.set("beacon_party", sid)
    for path in ("/remote/state", "/remote/songs", "/party-host/status"):
        assert guest_client.get(path).status_code == 401


@pytest.mark.parametrize("action", ["rotate", "disable"])
def test_rotating_or_ending_drops_every_guest(client, guest_client, action):
    token = _start(client)
    _join(guest_client, token)
    assert guest_client.get("/party/api/state").status_code == 200
    client.post(f"/party-host/{action}")
    assert guest_client.get("/party/api/state").status_code in (401, 404)
    if action == "rotate":
        assert _join(guest_client, token).status_code == 401


def test_party_ends_on_its_own_when_time_is_up(client, guest_client):
    token = _start(client)
    _join(guest_client, token)
    party.expires_at = time.time() - 1
    assert guest_client.get("/party/api/state").status_code == 404
    assert party.enabled is False


def test_party_is_stale_without_renderer_keepalive(client):
    _start(client)
    assert not party.is_stale()
    remote.last_keepalive = time.time() - 3600
    assert party.is_stale()


def test_status_never_returns_the_invite_token(client):
    token = _start(client)
    body = client.get("/party-host/status").json()
    assert token not in str(body)
    assert body["enabled"] is True


def test_the_window_that_starts_the_party_hosts_it(client):
    _start(client, tab_id="tab-desktop")
    assert client.get("/party-host/status").json()["host_tab"] == "tab-desktop"


async def test_only_the_host_windows_snapshots_reach_the_guests(client):
    _start(client, tab_id="tab-phone")
    host = _snapshot(["a"])
    host["party_tab"] = "tab-phone"
    await party.receive_snapshot(host)
    # The same account open on the desktop, pushing its own view.
    other = _snapshot(["z"])
    other["party_tab"] = None
    await party.receive_snapshot(other)
    assert party.snapshot["current_song"]["title"] == "Title a"


def test_another_window_can_take_the_party_over(client):
    token = _start(client, tab_id="tab-desktop")
    resp = client.post("/party-host/claim", json={"tab_id": "tab-phone"})
    assert resp.status_code == 200
    # The same link, so nobody already there has to scan again.
    assert resp.json()["token"] == token
    # What the desktop's next status poll sees, and lets go on.
    assert client.get("/party-host/status").json()["host_tab"] == "tab-phone"


def test_nothing_to_take_over_without_a_party(client):
    assert client.post("/party-host/claim", json={"tab_id": "tab-phone"}).status_code == 404


def test_a_tab_id_is_an_id_and_nothing_else(client):
    _start(client)
    resp = client.post("/party-host/claim", json={"tab_id": "<script>"})
    assert resp.status_code == 422


def test_a_new_party_forgets_the_last_host(client):
    _start(client, tab_id="tab-desktop")
    client.post("/party-host/disable")
    _start(client)
    assert client.get("/party-host/status").json()["host_tab"] is None


def test_kicked_guest_loses_access(client, guest_client):
    token = _start(client)
    _join(guest_client, token)
    guest_id = client.get("/party-host/status").json()["guests"][0]["guest_id"]
    assert client.delete(f"/party-host/guests/{guest_id}").status_code == 200
    assert guest_client.get("/party/api/state").status_code == 401


# ── Rate limits ─────────────────────────────────────────────────────────────


def test_token_guessing_locks_out(client, guest_client):
    token = _start(client)
    attempts, _ = party_routes.JOIN_FAILURES_PER_IP
    for _ in range(attempts):
        assert _join(guest_client, "wrong").status_code == 401
    # Locked out now, even with the right token.
    assert _join(guest_client, token).status_code == 429


def test_wishes_are_rate_limited(client, guest_client, relay):
    token = _start(client)
    _join(guest_client, token)
    limit, _ = party_routes.WISHES
    for _ in range(limit):
        assert guest_client.post("/party/api/wishes", json={"song_id": "s1"}).status_code == 200
    assert guest_client.post("/party/api/wishes", json={"song_id": "s1"}).status_code == 429


# ── Input ───────────────────────────────────────────────────────────────────


def test_names_are_cleaned():
    assert clean_name("  Anna  ") == "Anna"
    assert clean_name("A\u202eB\x00C") == "ABC"  # no bidi override, no control chars
    assert clean_name("x" * 100) == "x" * 24
    assert clean_name("   ") is None


def test_join_requires_a_name(client, guest_client):
    token = _start(client)
    assert _join(guest_client, token, name="\u200b ").status_code == 400


def test_a_name_already_in_use_is_refused(client, guest_client):
    token = _start(client)
    assert _join(guest_client, token, "Anna").status_code == 200
    # A different guest, normalised the same way ("anna" is "Anna").
    other = TestClient(app, raise_server_exceptions=False)
    other.headers.update({"Origin": ORIGIN})
    assert _join(other, token, "anna").status_code == 409
    # A different name still gets in.
    assert _join(other, token, "Ben").status_code == 200


def test_ids_are_validated(client, guest_client, relay):
    token = _start(client)
    _join(guest_client, token)
    bad = guest_client.post("/party/api/wishes", json={"song_id": "../../rest/ping?x=1"})
    assert bad.status_code == 400
    assert relay["commands"] == []


def test_search_is_capped(client, guest_client, relay):
    token = _start(client)
    _join(guest_client, token)
    guest_client.get(f"/party/api/songs?search={'a' * 500}&limit=5000&offset=-4")
    _, payload = relay["queries"][0]
    assert len(payload["search"]) == 100
    assert payload["limit"] == 50
    assert payload["offset"] == 0


def test_writes_from_another_origin_are_refused(client, guest_client, relay):
    token = _start(client)
    _join(guest_client, token)
    resp = guest_client.post(
        "/party/api/wishes", json={"song_id": "s1"}, headers={"Origin": "https://evil.example"}
    )
    assert resp.status_code == 403
    assert relay["commands"] == []


# ── What a guest can make the renderer do ───────────────────────────────────


def test_a_wish_is_the_only_command_it_sends(client, guest_client, relay):
    token = _start(client, max_pending_per_guest=2)
    _join(guest_client, token)
    assert guest_client.post("/party/api/wishes", json={"song_id": "s1"}).status_code == 200
    [(command_type, payload)] = relay["commands"]
    assert command_type == "party-wish"
    assert payload["songId"] == "s1"
    assert payload["guestName"] == "Anna"
    assert payload["maxPending"] == 2
    assert payload["guestId"]


def test_guests_cannot_reach_the_remote_command_relay(client, guest_client, relay):
    token = _start(client)
    _join(guest_client, token)
    for body in ({"type": "next"}, {"type": "seek", "payload": {"position": 0}}):
        assert guest_client.post("/remote/command", json=body).status_code in (401, 404)
        assert guest_client.post("/party/api/command", json=body).status_code == 404
    assert relay["commands"] == []


def test_renderer_refusals_reach_the_guest_as_such(client, guest_client, relay):
    token = _start(client)
    _join(guest_client, token)
    relay["answers"]["party-wish"] = "limit"
    assert guest_client.post("/party/api/wishes", json={"song_id": "s1"}).status_code == 409
    relay["answers"]["party-wish"] = "radio"
    resp = guest_client.post("/party/api/wishes", json={"song_id": "s1"})
    assert (resp.status_code, resp.json()["detail"]) == (409, "radio")
    relay["answers"]["party-withdraw"] = "forbidden"
    assert guest_client.delete("/party/api/wishes/r1").status_code == 403


def test_withdraw_names_the_guest(client, guest_client, relay):
    token = _start(client)
    _join(guest_client, token)
    guest_client.delete("/party/api/wishes/r1")
    [(command_type, payload)] = relay["commands"]
    assert command_type == "party-withdraw"
    assert payload["requestId"] == "r1"
    assert payload["guestId"]


# ── Skip votes ──────────────────────────────────────────────────────────────


def _guests(token, names):
    clients = []
    for name in names:
        c = TestClient(app, raise_server_exceptions=False)
        c.headers.update({"Origin": ORIGIN})
        assert _join(c, token, name).status_code == 200
        clients.append(c)
    return clients


def _connect(*guest_clients):
    """What an open event stream counts as - streaming one for real would
    never end (see test_remote.py's module docstring)."""
    for c in guest_clients:
        sid = c.cookies.get("beacon_party")
        party.streams[party.sessions[sid].guest_id] = 1


def test_one_guest_alone_can_skip_at_a_third(client, relay):
    """1/3 of one guest rounds up to one vote - the share is what the host
    chose, with nothing added on top."""
    token = _start(client, skip_ratio=1 / 3)
    party.update_snapshot(_snapshot(["a", "b"]))
    [anna] = _guests(token, ["Anna"])
    _connect(anna)
    assert party.skip_needed() == 1
    assert anna.post("/party/api/skip").status_code == 200
    assert relay["commands"] == [("next", {})]


def test_a_voter_counts_once(client, relay):
    token = _start(client, skip_ratio=1.0)
    party.update_snapshot(_snapshot(["a", "b"]))
    anna, ben = _guests(token, ["Anna", "Ben"])
    _connect(anna, ben)
    assert anna.post("/party/api/skip").status_code == 200
    assert anna.post("/party/api/skip").status_code == 200
    assert relay["commands"] == []
    assert ben.post("/party/api/skip").status_code == 200
    assert relay["commands"] == [("next", {})]


def test_skip_threshold_follows_connected_guests(client, relay):
    token = _start(client, skip_ratio=0.5)
    party.update_snapshot(_snapshot(["a", "b"]))
    guests = _guests(token, ["A", "B", "C", "D", "E", "F"])
    _connect(*guests)
    assert party.skip_needed() == 3
    for g in guests[:2]:
        g.post("/party/api/skip")
    assert relay["commands"] == []
    guests[2].post("/party/api/skip")
    assert relay["commands"] == [("next", {})]


def test_votes_reset_when_the_song_changes(client, relay):
    token = _start(client)
    party.update_snapshot(_snapshot(["a", "b"]))
    anna, ben, cleo = _guests(token, ["Anna", "Ben", "Cleo"])
    _connect(anna, ben, cleo)
    anna.post("/party/api/skip")
    party.update_snapshot(_snapshot(["a", "b"], index=1))
    assert party.skip_votes == set()


def test_skip_off_when_ratio_is_zero(client, guest_client, relay):
    token = _start(client, skip_ratio=0)
    party.update_snapshot(_snapshot(["a"]))
    _join(guest_client, token)
    assert guest_client.post("/party/api/skip").status_code == 409


def test_withdrawn_vote_no_longer_counts(client, relay):
    token = _start(client, skip_ratio=1.0)
    party.update_snapshot(_snapshot(["a"]))
    anna, ben = _guests(token, ["Anna", "Ben"])
    _connect(anna, ben)
    anna.post("/party/api/skip")
    anna.delete("/party/api/skip")
    ben.post("/party/api/skip")
    assert relay["commands"] == []


# ── What a guest gets to see ────────────────────────────────────────────────


def test_snapshot_is_filtered(client, guest_client):
    token = _start(client)
    requests = {"1": {"id": "r1", "guest_id": "someone-else", "guest_name": "Ben"}}
    party.update_snapshot(_snapshot(["a", "b", "c"], index=0, requests=requests))
    _join(guest_client, token)
    body = guest_client.get("/party/api/state").json()
    text = str(body)
    for leaked in ("host-session", "Living room", "volume", "stream_info", "someone-else"):
        assert leaked not in text
    assert "/remote/" not in text
    assert [s["id"] for s in body["upcoming"]] == ["b", "c"]
    assert body["upcoming"][0]["request"] == {"name": "Ben", "mine": False}


def test_own_requests_are_marked_and_counted(client, guest_client):
    token = _start(client, max_pending_per_guest=3)
    _join(guest_client, token)
    sid = guest_client.cookies.get("beacon_party")
    me = party.sessions[sid].guest_id
    requests = {
        "1": {"id": "r1", "guest_id": me, "guest_name": "Anna"},
        "2": {"id": "r2", "guest_id": "other", "guest_name": "Ben"},
    }
    party.update_snapshot(_snapshot(["a", "b", "c"], requests=requests))
    body = guest_client.get("/party/api/state").json()
    assert body["upcoming"][0]["request"] == {"name": "Anna", "mine": True, "id": "r1"}
    assert "id" not in body["upcoming"][1]["request"]
    assert body["limits"] == {"max_pending": 3, "pending": 1}


def test_radio_hides_the_current_song_and_skip(client, guest_client):
    token = _start(client)
    snapshot = _snapshot(["a"])
    snapshot["radio"] = {
        "name": "Station",
        "stream_url": "http://secret.example/stream",
        "home_page_url": "https://station.example",
        "favicon_hint": "https://station.example/logo.png",
        "now_playing": "Artist - Title",
    }
    party.update_snapshot(snapshot)
    _join(guest_client, token)
    body = guest_client.get("/party/api/state").json()
    assert body["radio"]["name"] == "Station"
    assert body["radio"]["now_playing"] == "Artist - Title"
    assert body["radio"]["logo"].startswith("/party/api/radio-logo?k=")
    assert "example" not in str(body)
    assert body["skip"]["enabled"] is False
    assert guest_client.post("/party/api/skip").status_code == 409


def _radio_snapshot(homepage="https://station.example", hint=""):
    snapshot = _snapshot([])
    snapshot["radio"] = {"name": "Station", "home_page_url": homepage, "favicon_hint": hint}
    return snapshot


def test_radio_logo_changes_url_per_station(client):
    _start(client)
    party.update_snapshot(_radio_snapshot("https://one.example"))
    first = party.snapshot["radio"]["logo"]
    party.update_snapshot(_radio_snapshot("https://two.example"))
    assert party.snapshot["radio"]["logo"] != first


@pytest.fixture
def favicon_lookups(monkeypatch):
    asked = []

    async def fake_favicon(url, min_size, hint):
        asked.append((url, min_size, hint))
        return Response(content=b"png-bytes", media_type="image/png")

    monkeypatch.setattr(party_routes, "radio_favicon", fake_favicon)
    return asked


def test_radio_logo_is_the_hosts_station_as_bytes(client, guest_client, favicon_lookups):
    token = _start(client)
    party.update_snapshot(_radio_snapshot(hint="https://station.example/logo.png"))
    _join(guest_client, token)
    resp = guest_client.get(party.snapshot["radio"]["logo"])
    assert resp.status_code == 200
    assert resp.content == b"png-bytes"
    assert favicon_lookups == [
        (
            "https://station.example",
            party_routes.RADIO_LOGO_SIZE,
            "https://station.example/logo.png",
        )
    ]


def test_radio_logo_is_gone_once_the_station_stops(client, guest_client, favicon_lookups):
    token = _start(client)
    party.update_snapshot(_radio_snapshot())
    party.update_snapshot(_snapshot(["a"]))
    _join(guest_client, token)
    assert guest_client.get("/party/api/radio-logo?k=x").status_code == 404


def test_radio_logo_requires_a_guest(client, guest_client):
    _start(client)
    party.update_snapshot(_radio_snapshot())
    assert guest_client.get("/party/api/radio-logo?k=x").status_code == 401


# ── Cover art ───────────────────────────────────────────────────────────────


@pytest.fixture
def subsonic_cover(default_session, monkeypatch):
    default_session.media = SubsonicClient(
        "http://navidrome.example:4533", user="alice", password="secret"
    )

    async def fake_get(url, **kwargs):
        response = type("R", (), {})()
        response.status_code = 200
        response.headers = {"content-type": "image/jpeg"}
        response.content = b"jpeg-bytes"
        return response

    fake_client = type("C", (), {"get": staticmethod(fake_get)})()
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)
    coverart_module._reset_cache()
    yield default_session
    coverart_module._reset_cache()


def test_cover_is_served_as_bytes_for_shown_artwork(client, guest_client, subsonic_cover):
    token = _start(client)
    party.update_snapshot(_snapshot(["a"], session_id=subsonic_cover.session_id))
    _join(guest_client, token)
    resp = guest_client.get("/party/api/cover?id=cov-a", follow_redirects=False)
    assert resp.status_code == 200
    assert resp.content == b"jpeg-bytes"
    assert "location" not in resp.headers


def test_cover_refuses_artwork_never_shown(client, guest_client, subsonic_cover):
    token = _start(client)
    party.update_snapshot(_snapshot(["a"], session_id=subsonic_cover.session_id))
    _join(guest_client, token)
    assert guest_client.get("/party/api/cover?id=cov-zzz").status_code == 404


def test_cover_requires_a_guest(client, guest_client, subsonic_cover):
    _start(client)
    party.update_snapshot(_snapshot(["a"], session_id=subsonic_cover.session_id))
    assert guest_client.get("/party/api/cover?id=cov-a").status_code == 401


# ── Page and headers ────────────────────────────────────────────────────────


def test_page_is_served_with_security_headers(client, guest_client):
    _start(client)
    resp = guest_client.get("/party/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    csp = resp.headers["content-security-policy"]
    assert "script-src 'self'" in csp and "unsafe-inline" not in csp
    assert resp.headers["x-frame-options"] == "DENY"
    assert resp.headers["referrer-policy"] == "no-referrer"
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_error_answers_carry_the_headers_too(guest_client):
    resp = guest_client.get("/party/api/state")
    assert resp.status_code == 404
    assert resp.headers["x-frame-options"] == "DENY"


def test_no_cors_under_party(client, guest_client):
    _start(client)
    resp = guest_client.get("/party/", headers={"Origin": "http://localhost:5173"})
    assert "access-control-allow-origin" not in resp.headers


def test_page_assets_and_shared_icons_are_served(client, guest_client):
    _start(client)
    assert guest_client.get("/party/assets/index-abc.js").status_code == 200
    assert guest_client.get("/party/icon-192.png").status_code == 200


def test_page_carries_a_fresh_nonce_its_csp_allows(client, guest_client):
    """Vuetify's theme <style> is the one inline style allowed, by nonce."""
    _start(client)
    first = guest_client.get("/party/")
    second = guest_client.get("/party/")
    nonce = re.search(r'content="([^"]+)"', first.text).group(1)
    assert nonce != "__CSP_NONCE__"
    assert f"style-src 'self' 'nonce-{nonce}'" in first.headers["content-security-policy"]
    assert nonce not in second.text  # never reused
    assert first.headers["cache-control"] == "no-store"
    assert "unsafe-inline" not in first.headers["content-security-policy"]


def test_deep_links_get_the_page(client, guest_client):
    _start(client)
    assert "Beacon Party" in guest_client.get("/party/queue").text


@pytest.mark.parametrize(
    "path",
    [
        "app.js",
        "sw.js",
        "js/router.js",
        "fonts/materialdesignicons-webfont.woff2",
        "fonts/mdi.css",
        "..%2Fremote%2Fapp.js",
        "%2e%2e/main.py",
        "api/nope",
    ],
)
def test_nothing_else_is_reachable(client, guest_client, path):
    _start(client)
    resp = guest_client.get(f"/party/{path}")
    assert resp.status_code == 404 or "Beacon Party" in resp.text


def test_party_settings_default():
    assert Settings().max_pending_per_guest == 3


def test_open_streams_are_capped_per_guest(client, guest_client):
    token = _start(client)
    _join(guest_client, token)
    (guest,) = party.sessions.values()
    party.streams[guest.guest_id] = party_routes.MAX_STREAMS_PER_GUEST
    assert guest_client.get("/party/api/events").status_code == 429


def test_open_streams_are_capped_in_total(client, guest_client):
    token = _start(client)
    _join(guest_client, token)
    party.streams["someone-else"] = party_routes.MAX_STREAMS_TOTAL
    assert guest_client.get("/party/api/events").status_code == 429


def test_the_current_song_names_who_wished_for_it(client, guest_client):
    token = _start(client)
    requests = {"0": {"id": "r1", "guest_id": "someone", "guest_name": "Ben"}}
    party.update_snapshot(_snapshot(["a", "b"], index=0, requests=requests))
    _join(guest_client, token)
    current = guest_client.get("/party/api/state").json()["current_song"]
    assert current["wished_by"] == "Ben"
    assert "someone" not in str(current)


# ── Live updates ────────────────────────────────────────────────────────────
# Driven through the generator directly, as test_remote.py does: a real
# stream never ends on its own.


async def _time_out(coro, timeout):
    coro.close()
    raise TimeoutError()


def _events_request(sid: str):
    from starlette.requests import Request

    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/party/api/events",
            "headers": [(b"cookie", f"beacon_party={sid}".encode())],
            "client": ("203.0.113.5", 1234),
            "query_string": b"",
        }
    )


async def _open_stream():
    party.enable()
    sid, guest = party.join("Anna", "203.0.113.5")
    resp = await party_routes.guest_events(_events_request(sid), guest)
    gen = resp.body_iterator
    await gen.__anext__()  # retry
    first = await gen.__anext__()
    return guest, gen, first


async def test_events_open_with_the_guests_own_view():
    guest, gen, first = await _open_stream()
    try:
        assert '"me": {"name": "Anna"}' in first
        assert party.streams[guest.guest_id] == 1
    finally:
        await gen.aclose()
    assert guest.guest_id not in party.streams


async def test_guests_sharing_an_address_each_get_their_streams():
    # An office or a venue: every guest arrives from the same address.
    party.enable()
    for name in ("Ben", "Cleo"):
        _, other = party.join(name, "203.0.113.5")
        party.streams[other.guest_id] = party_routes.MAX_STREAMS_PER_GUEST
    sid, guest = party.join("Anna", "203.0.113.5")
    resp = await party_routes.guest_events(_events_request(sid), guest)
    gen = resp.body_iterator
    try:
        await gen.__anext__()  # retry
        assert '"me": {"name": "Anna"}' in await gen.__anext__()
    finally:
        await gen.aclose()


async def test_events_end_when_the_guest_is_removed():
    guest, gen, _ = await _open_stream()
    try:
        party.kick(guest.guest_id)
        await party.broadcast()
        assert await gen.__anext__() == 'data: {"ended": true}\n\n'
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()
    finally:
        await gen.aclose()


async def test_events_end_when_the_party_runs_out_of_time():
    from unittest.mock import patch

    _, gen, _ = await _open_stream()
    try:
        party.expires_at = time.time() - 1
        with patch("routes.party.asyncio.wait_for", _time_out):
            assert await gen.__anext__() == 'data: {"ended": true}\n\n'
    finally:
        await gen.aclose()


async def test_events_heartbeat_while_the_party_runs():
    from unittest.mock import patch

    _, gen, _ = await _open_stream()
    try:
        with patch("routes.party.asyncio.wait_for", _time_out):
            assert await gen.__anext__() == ": heartbeat\n\n"
    finally:
        await gen.aclose()


# ── Playback timing ─────────────────────────────────────────────────────────


def test_guests_hear_about_a_seek_but_not_about_every_tick(client):
    _start(client)
    party.update_snapshot(_snapshot(["a"]))
    before = party.snapshot
    ticking = dict(_snapshot(["a"]), position=before["position"] + 0.3)
    party.update_snapshot(ticking)
    assert not party._worth_telling(before, party.snapshot)
    seeked = dict(_snapshot(["a"]), position=before["position"] + 60)
    party.update_snapshot(seeked)
    assert party._worth_telling(before, party.snapshot)


def test_anything_but_the_position_is_worth_telling(client):
    _start(client)
    party.update_snapshot(_snapshot(["a", "b"]))
    before = party.snapshot
    party.update_snapshot(_snapshot(["a", "b"], index=1))
    assert party._worth_telling(before, party.snapshot)


def test_snapshot_says_whether_it_casts_but_not_where(client, guest_client):
    token = _start(client)
    party.update_snapshot(_snapshot(["a"]))
    _join(guest_client, token)
    body = guest_client.get("/party/api/state").json()
    assert body["casting"] is True
    assert "Living room" not in str(body)
    assert body["duration"] == 0 or isinstance(body["duration"], float)


# ── Lyrics and backdrop ─────────────────────────────────────────────────────


def test_lyrics_are_the_hosts_and_only_for_the_playing_song(client, guest_client):
    token = _start(client)
    party.update_snapshot(_snapshot(["a", "b"]))
    lines = [{"time": 1.0, "text": "First"}, {"time": 3.0, "text": "Second"}]
    assert (
        client.post(
            "/party-host/lyrics",
            json={"song_id": "a", "synced": True, "offset": 0.4, "lines": lines},
        ).status_code
        == 200
    )
    _join(guest_client, token)
    body = guest_client.get("/party/api/lyrics").json()
    assert body["lines"] == lines and body["offset"] == 0.4 and body["synced"] is True
    party.update_snapshot(_snapshot(["a", "b"], index=1))
    assert guest_client.get("/party/api/lyrics").json()["lines"] == []


def test_guests_cannot_push_lyrics(client, guest_client):
    token = _start(client)
    _join(guest_client, token)
    resp = guest_client.post("/party-host/lyrics", json={"song_id": "a", "lines": []})
    assert resp.status_code == 401


def test_lyrics_are_bounded(client):
    _start(client)
    party.set_lyrics("a", True, 0, [{"time": i, "text": "x" * 5000} for i in range(5000)])
    assert len(party.lyrics["lines"]) == 2000
    assert len(party.lyrics["lines"][0]["text"]) == 500


def test_backdrop_is_only_the_hosts_image(client, guest_client, monkeypatch):
    token = _start(client)
    snapshot = _snapshot(["a"])
    snapshot["party_backdrop"] = "https://assets.fanart.tv/fanart/music/x/bg.jpg"
    party.update_snapshot(snapshot)
    _join(guest_client, token)
    asked = []
    monkeypatch.setattr("core.fanart.get_cached_image", lambda url: asked.append(url) or b"jpeg")
    resp = guest_client.get("/party/api/backdrop?url=https://evil.example/x.jpg")
    assert resp.status_code == 200 and resp.content == b"jpeg"
    assert asked == ["https://assets.fanart.tv/fanart/music/x/bg.jpg"]
    assert guest_client.get("/party/api/state").json()["backdrop"] is True


def test_no_backdrop_without_one_from_the_host(client, guest_client):
    token = _start(client)
    party.update_snapshot(_snapshot(["a"]))
    _join(guest_client, token)
    assert guest_client.get("/party/api/backdrop").status_code == 404


# ── While the host casts ────────────────────────────────────────────────────


class _Speaker(BaseDelivery):
    """A cast target that is never reached for: the app shutting down at the
    end of a test stops whatever is still casting, and a real Chromecast
    would go looking for a device on the network."""

    async def play(self, *args, **kwargs) -> None:
        pass

    async def stop(self) -> None:
        pass


def _cast(session, queue_ids, index=0):
    """The host's session casting `queue_ids` at `index`, as connect holds it
    after a /play: ids only, the current track with its metadata."""
    st = session.state
    st.active_delivery = _Speaker("TV")
    st.queue = list(queue_ids)
    st.queue_index = index
    song_id = queue_ids[index]
    st.current_track = Track(
        id=song_id, title=f"Title {song_id}", artist="Artist", duration=200, album="Album"
    )
    st.is_streaming = True


def _titles(state: dict) -> tuple[str | None, list[str]]:
    current = state["current_song"]
    return (current["title"] if current else None, [s["title"] for s in state["upcoming"]])


def test_the_party_outlives_a_sleeping_window_while_the_host_casts(client, default_session):
    _start(client)
    party.update_snapshot(_snapshot(["a", "b"], session_id=default_session.session_id))
    _cast(default_session, ["a", "b"])
    remote.last_keepalive = time.time() - KEEPALIVE_TIMEOUT - 1
    assert party.is_stale() is False
    # The cast ends while the window still sleeps: nobody is left to answer.
    default_session.state.active_delivery = None
    assert party.is_stale() is True


def test_a_station_cast_still_needs_the_window(client, default_session):
    _start(client)
    party.update_snapshot(_snapshot(["a"], session_id=default_session.session_id))
    _cast(default_session, ["a"])
    default_session.state.radio_info = {"url": "http://station.example/live"}
    remote.last_keepalive = time.time() - KEEPALIVE_TIMEOUT - 1
    assert party.is_stale() is True


def test_guests_follow_the_cast_while_the_window_sleeps(client, guest_client, default_session):
    token = _start(client)
    party.update_snapshot(_snapshot(["a", "b", "c"], session_id=default_session.session_id))
    _join(guest_client, token)
    # The speaker moved on to b on its own; the window never said so.
    _cast(default_session, ["a", "b", "c"], index=1)
    party.rebuild()
    body = guest_client.get("/party/api/state").json()
    assert _titles(body) == ("Title b", ["Title c"])
    assert body["casting"] is True


def test_a_pause_at_the_speaker_reaches_the_guests(client, default_session):
    _start(client)
    party.update_snapshot(_snapshot(["a", "b"], session_id=default_session.session_id))
    _cast(default_session, ["a", "b"])
    default_session.state.clock.pause(42.0)
    party.rebuild()
    assert party.snapshot["playing"] is False


def test_a_song_the_window_never_showed_is_left_out(client, default_session):
    _start(client)
    party.update_snapshot(_snapshot(["a", "b"], session_id=default_session.session_id))
    # An autoplay top-up made while the window slept: only its id is known.
    _cast(default_session, ["a", "b", "z"])
    party.rebuild()
    assert _titles(party.snapshot) == ("Title a", ["Title b"])


def test_a_wish_follows_its_song_when_the_cast_queue_changes(client, default_session):
    _start(client)
    requests = {"2": {"id": "r1", "guest_id": "g1", "guest_name": "Anna"}}
    snapshot = _snapshot(["a", "b", "c"], requests=requests, session_id=default_session.session_id)
    party.update_snapshot(snapshot)
    _cast(default_session, ["a", "b", "c"], index=1)
    party.rebuild()
    assert party.snapshot["upcoming"][0]["request"]["name"] == "Anna"
    # The host moved things around in the app: Anna's wish is still c, and
    # the song now at its old place is nobody's.
    default_session.state.queue = ["a", "b", "a", "c"]
    party.rebuild()
    upcoming = party.snapshot["upcoming"]
    assert [entry["title"] for entry in upcoming] == ["Title a", "Title c"]
    assert "request" not in upcoming[0]
    assert upcoming[1]["request"]["name"] == "Anna"


def test_background_and_lyrics_only_for_the_song_the_window_knew(client, default_session):
    _start(client)
    snapshot = _snapshot(["a", "b"], session_id=default_session.session_id)
    snapshot["party_backdrop"] = "https://assets.fanart.tv/a.jpg"
    snapshot["party_lyrics_key"] = "a:lrclib"
    party.update_snapshot(snapshot)
    _cast(default_session, ["a", "b"])
    party.rebuild()
    assert party.snapshot["backdrop"] is True
    assert party.snapshot["lyrics_key"] == "a:lrclib"
    # Next song, window asleep: its artist's picture and lyrics are unknown.
    _cast(default_session, ["a", "b"], index=1)
    party.rebuild()
    assert party.snapshot["backdrop"] is False
    assert party.snapshot["lyrics_key"] is None


async def test_connect_looks_up_the_lyrics_a_sleeping_window_never_named(
    client, guest_client, default_session, monkeypatch
):
    token = _start(client)
    party.update_snapshot(_snapshot(["a", "b"], session_id=default_session.session_id))
    _cast(default_session, ["a", "b"], index=1)
    _join(guest_client, token)
    asked = []

    async def fake_auto(song):
        asked.append(song["title"])
        return {"synced": True, "lines": [{"time": 1.0, "text": "Found by connect"}]}

    monkeypatch.setattr(lyrics_routes, "auto_for_party", fake_auto)
    party.rebuild()
    await asyncio.sleep(0.05)
    # The window never named b; guests still get connect's own match.
    assert asked == ["Title b"]
    body = guest_client.get("/party/api/lyrics").json()
    assert body["lines"] == [{"time": 1.0, "text": "Found by connect"}]
    assert body["offset"] == 0.0
    state = guest_client.get("/party/api/state").json()
    assert state["lyrics_key"] == "b:connect"


async def test_connect_looks_up_a_song_once(client, default_session, monkeypatch):
    _start(client)
    party.update_snapshot(_snapshot(["a"], session_id=default_session.session_id))
    _cast(default_session, ["a"])
    asked = []

    async def fake_auto(song):
        asked.append(song["title"])
        return {"synced": True, "lines": [{"time": 1.0, "text": "x"}]}

    monkeypatch.setattr(lyrics_routes, "auto_for_party", fake_auto)
    for _ in range(3):
        party.rebuild()
        await asyncio.sleep(0.05)
    assert asked == ["Title a"]


async def test_connect_looks_up_the_background_a_sleeping_window_never_named(
    client, guest_client, default_session, monkeypatch
):
    token = _start(client)
    party.update_snapshot(_snapshot(["a", "b"], session_id=default_session.session_id))
    _cast(default_session, ["a", "b"], index=1)
    _join(guest_client, token)
    asked = []
    urls = [
        "https://assets.fanart.tv/fanart/music/x/bg1.jpg",
        "https://assets.fanart.tv/fanart/music/x/bg2.jpg",
    ]

    async def fake_art(artist):
        asked.append(artist)
        return {"background": urls[0], "backgrounds": urls}

    monkeypatch.setattr(fanart_module, "get_artist_art", fake_art)
    party.rebuild()
    await asyncio.sleep(0.05)
    assert asked == ["Artist"]
    state = guest_client.get("/party/api/state").json()
    assert state["backdrop"] is True
    assert state["backdrop_count"] == 2
    assert state["backdrop_index"] == 0


def test_local_playback_still_comes_from_the_window(client, default_session):
    _start(client)
    party.update_snapshot(
        _snapshot(["a", "b", "c"], index=1, session_id=default_session.session_id)
    )
    assert _titles(party.snapshot) == ("Title b", ["Title c"])


async def test_guests_hear_of_the_next_track_without_the_window(default_session):
    party.enable()
    await party.receive_snapshot(_snapshot(["a", "b", "c"], session_id=default_session.session_id))
    _cast(default_session, ["a", "b", "c"])
    guest_updates = party.event_bus.subscribe()
    await asyncio.sleep(0.05)
    _cast(default_session, ["a", "b", "c"], index=1)
    await default_session.event_bus.broadcast({"current_song_index": 1})
    update = await asyncio.wait_for(guest_updates.get(), timeout=1)
    assert update == {"kind": "update"}
    assert _titles(party.snapshot)[0] == "Title b"
    party.disable()
    await asyncio.sleep(0)
    assert default_session.event_bus.subscriber_count == 0


@pytest.fixture
def server_library(default_session, monkeypatch):
    """The host's media server answering search3/getAlbum/getSong."""
    found = {
        "id": "s9",
        "title": "Found",
        "artist": "Artist",
        "album": "Album",
        "duration": 180,
        "coverArt": "cov-s9",
    }

    def fake_get(endpoint, **params):
        if endpoint == "getAlbum.view":
            return {"album": {"id": "al9", "name": "Album", "artist": "Artist", "song": [found]}}
        return {"searchResult3": {"song": [found], "album": [{"id": "al9", "name": "Album"}]}}

    monkeypatch.setattr(default_session.media, "_get", fake_get)
    return default_session


def test_search_works_with_the_window_asleep_while_casting(client, guest_client, server_library):
    token = _start(client)
    party.update_snapshot(_snapshot(["a", "b"], session_id=server_library.session_id))
    _join(guest_client, token)
    _cast(server_library, ["a", "b"])
    remote.renderer_connected = False  # the host's phone is locked
    resp = guest_client.get("/party/api/songs?search=found")
    assert resp.status_code == 200
    assert [s["title"] for s in resp.json()["items"]] == ["Found"]
    assert guest_client.get("/party/api/albums?search=album").status_code == 200
    album = guest_client.get("/party/api/albums/al9").json()
    assert [s["title"] for s in album["songs"]] == ["Found"]


def test_without_a_cast_search_still_asks_the_window(client, guest_client, server_library):
    token = _start(client)
    party.update_snapshot(_snapshot(["a"], session_id=server_library.session_id))
    _join(guest_client, token)
    remote.renderer_connected = False
    assert guest_client.get("/party/api/songs?search=found").status_code == 503


def test_a_music_server_that_fails_is_reported_as_such(
    client, guest_client, default_session, monkeypatch
):
    token = _start(client)
    party.update_snapshot(_snapshot(["a"], session_id=default_session.session_id))
    _join(guest_client, token)
    _cast(default_session, ["a"])

    def failing(endpoint, **params):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(default_session.media, "_get", failing)
    resp = guest_client.get("/party/api/songs?search=x")
    assert resp.status_code == 503
    assert "connection refused" not in resp.text


def test_a_song_found_by_a_guest_is_known_once_it_is_queued(client, guest_client, server_library):
    token = _start(client)
    party.update_snapshot(_snapshot(["a"], session_id=server_library.session_id))
    _join(guest_client, token)
    _cast(server_library, ["a"])
    guest_client.get("/party/api/songs?search=found")
    server_library.state.queue = ["a", "s9"]
    party.rebuild()
    assert _titles(party.snapshot)[1] == ["Found"]


async def test_a_queue_song_nobody_named_is_looked_up(default_session, monkeypatch):
    asked = []

    def get_track(song_id):
        asked.append(song_id)
        return Track(id=song_id, title=f"Looked up {song_id}", artist="Artist", duration=100)

    monkeypatch.setattr(default_session.media, "get_track", get_track)
    party.enable()
    party.update_snapshot(_snapshot(["a", "b"], session_id=default_session.session_id))
    # An autoplay top-up made while the window slept.
    _cast(default_session, ["a", "b", "z"])
    guest_updates = party.event_bus.subscribe()
    party.rebuild()
    await asyncio.wait_for(guest_updates.get(), timeout=1)
    assert _titles(party.snapshot)[1] == ["Title b", "Looked up z"]
    assert asked == ["z"]


async def test_a_song_the_server_cannot_find_is_not_asked_for_again(default_session, monkeypatch):
    asked = []

    def get_track(song_id):
        asked.append(song_id)
        raise RuntimeError("not found")

    monkeypatch.setattr(default_session.media, "get_track", get_track)
    party.enable()
    party.update_snapshot(_snapshot(["a"], session_id=default_session.session_id))
    _cast(default_session, ["a", "gone"])
    for _ in range(3):
        party.rebuild()
        await asyncio.sleep(0.05)
    assert asked == ["gone"]
    assert _titles(party.snapshot)[1] == []


# ── Wishes while the host casts ─────────────────────────────────────────────


@pytest.fixture
def casting_party(client, default_session):
    """A party whose host casts ['now', 'h1', 'h2'] and whose window sleeps."""
    token = _start(client)
    party.update_snapshot(_snapshot(["now", "h1", "h2"], session_id=default_session.session_id))
    _cast(default_session, ["now", "h1", "h2"])
    default_session.state.original_queue = ["now", "h1", "h2"]
    remote.renderer_connected = False
    return token, default_session


def _wish(guest, song_id):
    # Found in a search first, as on the guest page - which is how connect
    # knows its title (see routes/party.py's _library).
    party.remember_song({"id": song_id, "title": f"Title {song_id}", "artist": "Artist"})
    return guest.post("/party/api/wishes", json={"song_id": song_id})


def _queue(session) -> list[str]:
    return list(session.state.queue)


def test_wishes_take_turns_on_the_cast_queue(casting_party):
    token, session = casting_party
    anna, ben = _guests(token, ["Anna", "Ben"])
    for song_id in ("a1", "a2", "a3"):
        assert _wish(anna, song_id).status_code == 200
    assert _wish(ben, "b1").status_code == 200
    assert _queue(session) == ["now", "a1", "b1", "a2", "a3", "h1", "h2"]
    # The unshuffled order keeps up, so turning shuffle off loses nothing.
    assert session.state.original_queue == ["now", "a1", "b1", "a2", "a3", "h1", "h2"]
    names = [e.get("request", {}).get("name") for e in party.snapshot["upcoming"]]
    assert names[:4] == ["Anna", "Ben", "Anna", "Anna"]


def test_a_wish_reaches_the_hosts_window_in_the_status(casting_party):
    token, session = casting_party
    (anna,) = _guests(token, ["Anna"])
    _wish(anna, "a1")
    status = build_status_dict(session)
    assert status["queue"][1] == "a1"
    assert [(r["position"], r["guest_name"]) for r in status["party_requests"]] == [(1, "Anna")]


def test_the_limit_and_duplicates_are_refused_on_the_cast(casting_party):
    token, _ = casting_party
    party.settings.max_pending_per_guest = 1
    anna, ben = _guests(token, ["Anna", "Ben"])
    assert _wish(anna, "a1").status_code == 200
    resp = _wish(anna, "a2")
    assert (resp.status_code, resp.json()["detail"]) == (409, "limit")
    resp = _wish(ben, "a1")
    assert (resp.status_code, resp.json()["detail"]) == (409, "duplicate")


def test_a_song_coming_up_moves_forward_on_the_cast(casting_party):
    token, session = casting_party
    (anna,) = _guests(token, ["Anna"])
    assert _wish(anna, "h2").status_code == 200
    assert _queue(session) == ["now", "h2", "h1"]


def test_a_song_already_played_is_queued_again_on_the_cast(casting_party):
    token, session = casting_party
    session.state.queue = ["old", "now", "h1"]
    session.state.queue_index = 1
    (anna,) = _guests(token, ["Anna"])
    _wish(anna, "old")
    assert _queue(session) == ["old", "now", "old", "h1"]


def test_a_guest_withdraws_their_own_wish_on_the_cast(casting_party):
    token, session = casting_party
    anna, ben = _guests(token, ["Anna", "Ben"])
    _wish(anna, "a1")
    _wish(ben, "b1")
    request_id = party.cast_requests[0].id
    assert ben.delete(f"/party/api/wishes/{request_id}").status_code == 403
    assert anna.delete(f"/party/api/wishes/{request_id}").status_code == 200
    assert _queue(session) == ["now", "b1", "h1", "h2"]
    assert "a1" not in session.state.original_queue
    assert [(r.song_id, r.position) for r in party.cast_requests] == [("b1", 1)]


def test_a_wish_that_is_playing_cannot_be_withdrawn(casting_party):
    token, session = casting_party
    (anna,) = _guests(token, ["Anna"])
    _wish(anna, "a1")
    session.state.queue_index = 1
    request_id = party.cast_requests[0].id
    assert anna.delete(f"/party/api/wishes/{request_id}").status_code == 404


def test_a_window_waking_with_an_old_queue_cannot_undo_a_wish(client, casting_party):
    token, session = casting_party
    stale_seq = int(time.time() * 1000) - 5_000  # built before it slept
    (anna,) = _guests(token, ["Anna"])
    _wish(anna, "a1")
    resp = client.post(
        "/queue",
        json={"song_ids": ["now", "h1", "h2"], "queue_index": 0, "seq": stale_seq},
    )
    assert resp.json()["status"] == "superseded"
    assert _queue(session) == ["now", "a1", "h1", "h2"]


def test_wishes_follow_a_queue_the_host_edits(casting_party):
    token, session = casting_party
    (anna,) = _guests(token, ["Anna"])
    _wish(anna, "a1")
    # The host, awake again, drags a1 to the end and removes h1.
    session.state.queue = ["now", "h2", "a1"]
    party.rebuild()
    assert [(r.song_id, r.position) for r in party.cast_requests] == [("a1", 2)]
    # ...and then removes the wish itself.
    session.state.queue = ["now", "h2"]
    party.rebuild()
    assert party.cast_requests == []


def test_a_wish_stays_with_its_own_copy_when_the_host_adds_the_song_again(casting_party):
    token, session = casting_party
    anna, ben = _guests(token, ["Anna", "Ben"])
    _wish(anna, "a1")
    _wish(ben, "b1")
    _wish(anna, "x")
    assert _queue(session) == ["now", "a1", "b1", "x", "h1", "h2"]
    # The host queues x once more, right after the current song.
    session.state.queue = ["now", "x", "a1", "b1", "x", "h1", "h2"]
    party.rebuild()
    wish = next(r for r in party.cast_requests if r.song_id == "x")
    assert wish.position == 4


def test_a_wish_is_let_go_once_it_has_played(casting_party):
    token, session = casting_party
    (anna,) = _guests(token, ["Anna"])
    _wish(anna, "a1")
    session.state.queue_index = 2
    party.rebuild()
    assert party.cast_requests == []


def test_wishes_taken_before_the_cast_carry_over(client, default_session):
    _start(client)
    requests = {"1": {"id": "r1", "guest_id": "g1", "guest_name": "Anna"}}
    party.update_snapshot(
        _snapshot(["now", "a1", "h1"], requests=requests, session_id=default_session.session_id)
    )
    _cast(default_session, ["now", "a1", "h1"])
    party.rebuild()
    assert [(r.id, r.position, r.guest_name) for r in party.cast_requests] == [("r1", 1, "Anna")]


def test_the_window_gets_the_wishes_back_when_the_cast_ends(casting_party):
    token, session = casting_party
    (anna,) = _guests(token, ["Anna"])
    _wish(anna, "a1")
    assert "party_requests" in build_status_dict(session)
    session.state.active_delivery = None
    party.rebuild()
    assert "party_requests" not in build_status_dict(session)
    assert party.cast_owned is False


def test_a_skip_vote_skips_the_cast_itself(casting_party, monkeypatch):
    token, session = casting_party
    party.settings.skip_ratio = 0.5
    skipped = []

    async def fake_advance(s):
        skipped.append(s)
        return True

    monkeypatch.setattr(party_routes, "advance_now", fake_advance)
    (anna,) = _guests(token, ["Anna"])
    _connect(anna)
    assert anna.post("/party/api/skip").status_code == 200
    assert skipped == [session]


async def test_advance_now_moves_the_cast_on(default_session, monkeypatch):
    from routes import stream

    _cast(default_session, ["a", "b"])

    async def resolve(session, track_id, context):
        return Track(id=track_id, title=f"Title {track_id}", artist="Artist", duration=200)

    async def dispatch(session, target, track, gain):
        session.state.current_track = track
        return True

    monkeypatch.setattr(stream, "_resolve_track", resolve)
    monkeypatch.setattr(stream, "_dispatch_queued_track", dispatch)
    assert await stream.advance_now(default_session) is True
    assert default_session.state.queue_index == 1
    assert default_session.play_seq > 0
    # Nothing after b, and no autoplay to find more.
    assert await stream.advance_now(default_session) is False


# ── Visualizer ──────────────────────────────────────────────────────────────


def test_visualizer_frames_reach_every_watching_guest():
    first = asyncio.Queue(maxsize=4)
    second = asyncio.Queue(maxsize=4)
    party.visualizer_queues[:] = [first, second]
    try:
        for n in range(6):
            party._on_frame([n / 10])
        # Both get frames, neither takes them from the other, and a slow one
        # keeps the freshest.
        assert first.qsize() == 4 and second.qsize() == 4
        assert first.get_nowait() == [0.2]
    finally:
        party.visualizer_queues.clear()


def test_visualizer_only_follows_a_cast(client):
    _start(client)
    snapshot = _snapshot(["a"])
    snapshot["casting"] = []
    party.update_snapshot(snapshot)
    assert party._host_feed() is None


async def test_visualizer_listens_without_taking_the_hosts_frames(default_session):
    """The cast analysis has one queue with one reader (GET /visualizer);
    guests listen beside it."""

    class FakeAnalyzer:
        def __init__(self):
            self.listeners = []

    class FakeFeed:
        def __init__(self):
            self.analyzer = FakeAnalyzer()
            self.subscribed = 0

        def subscribe(self):
            self.subscribed += 1

        def unsubscribe(self):
            self.subscribed -= 1

    feed = FakeFeed()
    default_session.visualizer = feed
    party.enable()
    party.update_snapshot(_snapshot(["a"], session_id=default_session.session_id))
    queue = party.watch_visualizer()
    await asyncio.sleep(0.05)
    assert feed.subscribed == 1
    assert party._on_frame in feed.analyzer.listeners
    party.unwatch_visualizer(queue)
    await asyncio.sleep(0.4)
    assert feed.subscribed == 0
    assert feed.analyzer.listeners == []


def test_guests_step_through_the_hosts_backgrounds_only(client, guest_client, monkeypatch):
    token = _start(client)
    snapshot = _snapshot(["a"])
    urls = [f"https://assets.fanart.tv/fanart/music/x/bg{n}.jpg" for n in range(3)]
    snapshot["party_backdrop"] = urls[1]
    snapshot["party_backdrops"] = urls
    party.update_snapshot(snapshot)
    _join(guest_client, token)
    asked = []
    monkeypatch.setattr("core.fanart.get_cached_image", lambda url: asked.append(url) or b"jpeg")
    state = guest_client.get("/party/api/state").json()
    assert state["backdrop_count"] == 3 and state["backdrop_index"] == 1
    assert guest_client.get("/party/api/backdrop?index=2").status_code == 200
    assert guest_client.get("/party/api/backdrop?index=3").status_code == 404
    assert guest_client.get("/party/api/backdrop?index=-1").status_code == 404
    assert asked == [urls[2]]
    assert "fanart.tv" not in str(state)


def test_backdrop_list_is_bounded_and_keeps_the_hosts_pick(client):
    _start(client)
    snapshot = _snapshot(["a"])
    snapshot["party_backdrop"] = "https://assets.fanart.tv/host.jpg"
    snapshot["party_backdrops"] = [f"https://assets.fanart.tv/{n}.jpg" for n in range(100)] + [7]
    party.update_snapshot(snapshot)
    assert len(party.backdrop_urls) == 31
    assert party.backdrop_urls[0] == "https://assets.fanart.tv/host.jpg"
