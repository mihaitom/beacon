"""Tests for core/cast_permissions.py + routes/cast_permissions.py + the
enforcement points in the cast routes — the admin's cast policy (mode +
unlisted default + list). See docs/cast-permissions.md for the plan and
core/cast_permissions.py's own docstring for the trust model (a policy among
cooperative users, not a security boundary)."""

import json
import os
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from core import cast_permissions
from core.cast_permissions import (
    allowed_accounts,
    authorize,
    is_allowed,
    is_restricted,
    known_accounts,
    normalize_server_url,
    policy,
    record_account,
    set_policy,
)
from core.claims import Claim, claims
from main import app
from media import SubsonicClient, Track

URL = "http://nav:4533"


@pytest.fixture(autouse=True)
def _isolated_storage():
    """Same isolation pattern as test_account_settings.py — the real
    cast_permissions.json under CONNECT_DATA_DIR must never be touched."""
    with tempfile.TemporaryDirectory() as d:
        with patch.object(cast_permissions, "_PATH", str(Path(d) / "cast_permissions.json")):
            yield


def _configure(session, username, is_admin=False, url=URL):
    """Give the default session the verified-account fields /config would
    have set (routes/devices.py), without the real network lookup."""
    session.media = SubsonicClient(url)
    session.account_server_type = "subsonic"
    session.account_server_url = url
    session.account_username = username
    session.account_is_admin = is_admin


def _allow(accounts, url=URL, server_type="subsonic"):
    """The classic household whitelist: listed may cast, everyone else not."""
    set_policy(server_type, url, accounts, "allowlist", False)


def _block(accounts, url=URL, server_type="subsonic"):
    """A blacklist: listed may not cast, everyone else may."""
    set_policy(server_type, url, accounts, "blocklist", True)


# ── core/cast_permissions.py — plain unit tests ─────────────────────────────


def test_nothing_configured_means_everyone_may_cast():
    assert allowed_accounts("subsonic", URL) == []
    assert policy("subsonic", URL) is None
    assert is_restricted("subsonic", URL) is False
    assert is_allowed("subsonic", URL, "guest", False) is True


def test_an_allowlist_lets_the_listed_cast_and_no_one_else():
    _allow(["alice"])

    assert policy("subsonic", URL) == ("allowlist", False)
    assert is_allowed("subsonic", URL, "alice", False) is True
    assert is_allowed("subsonic", URL, "guest", False) is False


def test_a_blocklist_blocks_the_listed_and_lets_everyone_else():
    _block(["guest"])

    assert is_allowed("subsonic", URL, "guest", False) is False
    assert is_allowed("subsonic", URL, "alice", False) is True


def test_an_empty_allowlist_blocks_everyone_but_admins():
    _allow([])

    assert is_allowed("subsonic", URL, "alice", False) is False
    assert is_allowed("subsonic", URL, "admin", True) is True


def test_an_empty_blocklist_blocks_nobody():
    _block([])

    assert is_allowed("subsonic", URL, "anyone", False) is True


def test_an_allowlist_with_unlisted_allowed_lets_everyone_cast():
    """A deliberately inert combination — the list only says what listed
    accounts get, and the default already allows them."""
    set_policy("subsonic", URL, ["alice"], "allowlist", True)

    assert is_allowed("subsonic", URL, "alice", False) is True
    assert is_allowed("subsonic", URL, "guest", False) is True


def test_matching_ignores_case():
    _allow(["Alice"])

    assert is_allowed("subsonic", URL, "alice", False) is True


def test_an_admin_is_allowed_even_when_listed_as_blocked():
    _block(["admin"])

    assert is_allowed("subsonic", URL, "admin", True) is True


def test_an_unverified_account_lands_on_the_configured_default():
    """A lookup failure at /config must not open the door on an allowlist,
    and must not close it on a blocklist."""
    _allow(["alice"])
    assert is_allowed("subsonic", URL, "", False) is False

    _block(["guest"])
    assert is_allowed("subsonic", URL, "", False) is True


def test_set_policy_drops_blanks_and_collapses_duplicates():
    stored = set_policy("subsonic", URL, [" alice ", "", "Alice", "bob"], "blocklist", True)

    assert stored == (["alice", "bob"], "blocklist", True)
    assert allowed_accounts("subsonic", URL) == ["alice", "bob"]
    assert policy("subsonic", URL) == ("blocklist", True)


def test_set_policy_rejects_an_unknown_mode():
    stored = set_policy("subsonic", URL, ["alice"], "nonsense", False)

    assert stored[1] == "allowlist"


def test_rules_are_scoped_per_server():
    _allow(["alice"])

    assert is_allowed("subsonic", "http://other:4533", "alice", False) is True
    assert is_allowed("jellyfin", URL, "alice", False) is True


@pytest.mark.parametrize(
    "written",
    [
        "https://nav:4533",
        "http://nav:4533/",
        "http://NAV:4533",
    ],
)
def test_server_url_normalization_collapses_equivalent_forms(written):
    _allow(["alice"], url=written)

    assert is_allowed("subsonic", URL, "alice", False) is True
    assert is_allowed("subsonic", URL, "guest", False) is False


def test_normalize_keeps_a_sub_path():
    assert normalize_server_url("http://nav:4533/music") == "nav:4533/music"


def test_authorize_returns_the_refusal_body():
    _allow(["alice"])

    class FakeSession:
        display_name = "guest"
        account_server_type = "subsonic"
        account_server_url = URL
        account_username = "guest"
        account_is_admin = False

    assert authorize(FakeSession()) == {"error": "cast_forbidden", "account": "guest"}


def test_authorize_is_none_for_a_listed_account():
    _allow(["alice"])

    class FakeSession:
        display_name = "alice"
        account_server_type = "subsonic"
        account_server_url = URL
        account_username = "alice"
        account_is_admin = False

    assert authorize(FakeSession()) is None


def test_an_unreadable_store_is_kept_aside_not_overwritten():
    _allow(["alice"])
    with open(cast_permissions._PATH, "w", encoding="utf-8") as f:
        f.write("{not json")

    _allow(["bob"])

    assert allowed_accounts("subsonic", URL) == ["bob"]
    with open(f"{cast_permissions._PATH}.corrupt", encoding="utf-8") as f:
        assert f.read() == "{not json"


def test_an_interrupted_write_leaves_the_previous_file_intact(monkeypatch):
    _allow(["alice"])

    def boom(*args, **kwargs):
        raise OSError("No space left on device")

    monkeypatch.setattr(cast_permissions.json, "dump", boom)
    _allow(["bob"])
    monkeypatch.undo()

    assert allowed_accounts("subsonic", URL) == ["alice"]
    assert not os.path.exists(f"{cast_permissions._PATH}.tmp")


def test_concurrent_writes_do_not_lose_each_other():
    """Two admins saving at once is a read-modify-write over a shared file;
    without the lock the later write would drop the earlier server's entry."""
    servers = [f"http://host{i}:4533" for i in range(15)]
    barrier = threading.Barrier(len(servers))

    def push(url: str) -> None:
        barrier.wait()
        _allow(["alice"], url=url)

    threads = [threading.Thread(target=push, args=(u,)) for u in servers]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    with open(cast_permissions._PATH, encoding="utf-8") as f:
        data = json.load(f)
    assert len(data["servers"]) == len(servers)


# ── Known accounts (what the picker offers) ─────────────────────────────────


def test_known_accounts_are_recorded_and_deduped_case_insensitively():
    record_account("subsonic", URL, "alice")
    record_account("subsonic", URL, "Alice")
    record_account("subsonic", URL, "bob")

    assert known_accounts("subsonic", URL) == ["alice", "bob"]


def test_known_accounts_are_scoped_per_server():
    record_account("subsonic", URL, "alice")

    assert known_accounts("subsonic", "http://other:4533") == []
    assert known_accounts("jellyfin", URL) == []


def test_set_policy_preserves_the_known_list():
    record_account("subsonic", URL, "alice")

    _allow(["alice"])

    assert known_accounts("subsonic", URL) == ["alice"]


def test_record_account_does_not_clobber_an_unreadable_store():
    with open(cast_permissions._PATH, "w", encoding="utf-8") as f:
        f.write("{not json")

    record_account("subsonic", URL, "alice")

    with open(cast_permissions._PATH, encoding="utf-8") as f:
        assert f.read() == "{not json"


def test_config_records_the_verified_account_for_the_picker(client, default_session, monkeypatch):
    """The verified username /config resolves is what the picker offers —
    never the request body's claim."""
    from media import ResolvedAccount
    from routes import devices as devices_mod

    async def fake_resolve(media, hint=""):
        return ResolvedAccount("alice", False, True)

    monkeypatch.setattr(devices_mod, "resolve_account", fake_resolve)

    client.post("/config", json={"url": URL, "credential": "x", "username": "whoever"})

    assert known_accounts("subsonic", URL) == ["alice"]


# ── Enforcement in the cast routes ──────────────────────────────────────────


def _track():
    return Track(id="1", title="Test Song", artist="Test Artist", duration=180)


def test_play_refuses_a_non_household_account_and_does_not_claim(client, default_session):
    _allow(["alice"])
    _configure(default_session, "guest")

    with patch.object(default_session.media, "get_track", return_value=_track()):
        r = client.post(
            "/play",
            json={
                "song_ids": ["1"],
                "target_type": "chromecast",
                "target_name": "TV",
                "paused": True,
            },
        )

    assert r.json()["error"] == "cast_forbidden"
    assert default_session.state.active_delivery is None
    assert claims.owner_of("chromecast", "TV") is None


def test_play_allows_a_listed_account(client, default_session):
    _allow(["alice"])
    _configure(default_session, "alice")

    with patch.object(default_session.media, "get_track", return_value=_track()):
        r = client.post(
            "/play",
            json={
                "song_ids": ["1"],
                "target_type": "chromecast",
                "target_name": "TV",
                "paused": True,
            },
        )

    assert "error" not in r.json()
    assert claims.owner_of("chromecast", "TV") == default_session.session_id


def test_play_url_refuses_a_non_household_account(client, default_session):
    _allow(["alice"])
    _configure(default_session, "guest")

    r = client.post(
        "/play-url",
        json={
            "target_type": "chromecast",
            "target_name": "TV",
            "title": "Station",
            "url": "https://example.com/stream.mp3",
        },
    )

    assert r.json()["error"] == "cast_forbidden"
    assert claims.owner_of("chromecast", "TV") is None


def test_join_refuses_a_non_household_account(client, default_session):
    _allow(["alice"])
    _configure(default_session, "guest")
    default_session.state.is_streaming = True

    r = client.post(
        "/join",
        json={"target_type": "chromecast", "target_name": "TV"},
    )

    assert r.json()["error"] == "cast_forbidden"
    assert claims.owner_of("chromecast", "TV") is None


def test_claim_refuses_a_non_household_account(client, default_session):
    _allow(["alice"])
    _configure(default_session, "guest")

    r = client.post(
        "/claim",
        json={"targets": [{"type": "chromecast", "name": "TV"}]},
    )

    assert r.json()["error"] == "cast_forbidden"
    assert claims.owner_of("chromecast", "TV") is None


# ── routes/cast_permissions.py — HTTP level ─────────────────────────────────


def test_get_cast_permissions_requires_token():
    with TestClient(app, raise_server_exceptions=False) as c:
        assert c.get("/cast-permissions").status_code == 401


def test_get_cast_permissions_returns_the_list(client, default_session):
    _allow(["alice"])
    record_account("subsonic", URL, "alice")
    _configure(default_session, "alice", is_admin=True)

    r = client.get("/cast-permissions")

    assert r.status_code == 200
    body = r.json()
    assert body["accounts"] == ["alice"]
    assert body["mode"] == "allowlist"
    assert body["default_allow"] is False
    # Subsonic/Navidrome cannot list its other users, so the suggestions are
    # only the accounts seen at this Beacon, and the flag says so.
    assert body["suggested_accounts"] == ["alice"]
    assert body["lists_users"] is False


def test_get_cast_permissions_reports_an_unconfigured_server_as_open(client, default_session):
    _configure(default_session, "alice", is_admin=True)

    body = client.get("/cast-permissions").json()

    assert body["accounts"] == []
    assert body["mode"] == "allowlist"
    assert body["default_allow"] is True


def test_get_cast_permissions_suggests_the_jellyfin_account_list(
    client, default_session, monkeypatch
):
    from media import JellyfinClient

    default_session.media = JellyfinClient("http://jf:8096")
    default_session.account_server_type = "jellyfin"
    default_session.account_server_url = "http://jf:8096"
    default_session.account_username = "admin"
    default_session.account_is_admin = True

    async def fake_get_users(_params, _media):
        return {"users": {"user": [{"username": "admin"}, {"username": "rita"}]}}

    monkeypatch.setattr("media.jellyfin_bridge.get_users", fake_get_users)

    body = client.get("/cast-permissions").json()

    assert body["lists_users"] is True
    assert body["suggested_accounts"] == ["admin", "rita"]


def test_get_cast_permissions_uses_a_full_subsonic_user_list(client, default_session, monkeypatch):
    """A spec-compliant server answers getUsers.view with every account."""
    _configure(default_session, "admin", is_admin=True)
    monkeypatch.setattr(
        default_session.media,
        "get_users",
        lambda: [{"username": "admin"}, {"username": "rita"}],
    )

    body = client.get("/cast-permissions").json()

    assert body["lists_users"] is True
    assert body["suggested_accounts"] == ["admin", "rita"]


def test_get_cast_permissions_treats_a_single_subsonic_user_as_incomplete(
    client, default_session, monkeypatch
):
    """Navidrome answers getUsers.view with the calling user alone; a single
    result must not be read as the whole server."""
    _configure(default_session, "admin", is_admin=True)
    monkeypatch.setattr(default_session.media, "get_users", lambda: [{"username": "admin"}])

    body = client.get("/cast-permissions").json()

    assert body["lists_users"] is False
    assert body["suggested_accounts"] == ["admin"]


def test_put_cast_permissions_replaces_the_policy(client, default_session):
    _configure(default_session, "alice", is_admin=True)

    r = client.put(
        "/cast-permissions",
        json={"accounts": ["guest"], "mode": "blocklist", "default_allow": True},
    )

    assert r.status_code == 200
    assert r.json() == {
        "accounts": ["guest"],
        "mode": "blocklist",
        "default_allow": True,
    }
    assert policy("subsonic", URL) == ("blocklist", True)


def test_cast_permissions_refuse_a_non_admin(client, default_session):
    _configure(default_session, "alice", is_admin=False)

    assert client.get("/cast-permissions").status_code == 403
    assert client.put("/cast-permissions", json={"accounts": ["alice"]}).status_code == 403


def test_cast_permissions_are_offered_to_a_plex_owner(client, default_session):
    from media import PlexClient

    record_account("plex", PLEX_SERVER, "alice")
    default_session.media = PlexClient("http://plex:32400")
    default_session.account_server_type = "plex"
    default_session.account_server_url = PLEX_SERVER
    default_session.account_is_admin = True

    r = client.get("/cast-permissions")

    assert r.status_code == 200
    assert r.json()["suggested_accounts"] == ["alice"]
    assert r.json()["lists_users"] is False


# ── Plex: naming the account behind a server token ──────────────────────────

PLEX_SERVER = "plex://machine-abc"


def test_a_confirmed_plex_account_is_found_again_by_its_server_token():
    cast_permissions.remember_plex_account("server-token", PLEX_SERVER, "alice")

    assert cast_permissions.known_plex_account("server-token", PLEX_SERVER) == "alice"
    assert cast_permissions.known_plex_account("other-token", PLEX_SERVER) == ""
    # The same token presented as another server's is not the same account.
    assert cast_permissions.known_plex_account("server-token", "plex://elsewhere") == ""


def test_the_plex_token_store_holds_no_usable_token():
    cast_permissions.remember_plex_account("server-token", PLEX_SERVER, "alice")

    with open(cast_permissions._PATH, encoding="utf-8") as f:
        assert "server-token" not in f.read()


def _plex_config(client, monkeypatch, owner_of_token, account_token="account-token"):
    """/config for a Plex login, with plex.tv and the server stubbed: the
    account token names `owner_of_token` if the server token is one of its
    own, nobody otherwise."""
    from media import ResolvedAccount
    from routes import devices as devices_mod

    async def fake_resolve(media, hint=""):
        return ResolvedAccount("", False, False, PLEX_SERVER)

    def fake_confirm(account, server_token):
        return owner_of_token if server_token == "server-token" else ""

    monkeypatch.setattr(devices_mod, "resolve_account", fake_resolve)
    monkeypatch.setattr(devices_mod, "account_username_for_server_token", fake_confirm)
    body = {
        "url": "http://10.0.0.5:32400",
        "credential": "server-token",
        "server_type": "plex",
        "machine_identifier": "machine-abc",
        "username": "whoever",
    }
    if account_token:
        body["plex_account_token"] = account_token
    return client.post("/config", json=body)


def test_a_plex_login_names_the_account_and_keys_rules_by_the_server(
    client, default_session, monkeypatch
):
    _plex_config(client, monkeypatch, owner_of_token="alice")

    assert default_session.account_username == "alice"
    assert default_session.account_server_url == PLEX_SERVER
    assert known_accounts("plex", PLEX_SERVER) == ["alice"]


def test_a_plex_reload_without_the_account_token_keeps_the_name(
    client, default_session, monkeypatch
):
    _plex_config(client, monkeypatch, owner_of_token="alice")
    default_session.account_username = ""

    _plex_config(client, monkeypatch, owner_of_token="alice", account_token="")

    assert default_session.account_username == "alice"


def test_a_plex_account_token_that_does_not_own_the_server_token_names_nobody(
    client, default_session, monkeypatch
):
    _plex_config(client, monkeypatch, owner_of_token="")

    assert default_session.account_username == ""
    assert known_accounts("plex", PLEX_SERVER) == []


def test_an_unconfirmed_plex_listener_lands_on_the_default(client, default_session, monkeypatch):
    set_policy("plex", PLEX_SERVER, ["alice"], "allowlist", False)

    _plex_config(client, monkeypatch, owner_of_token="", account_token="")

    assert authorize(default_session) is not None


# ── Display filtering ───────────────────────────────────────────────────────


def test_discover_hides_every_device_from_a_non_household_account(
    client, default_session, monkeypatch
):
    from routes import discovery as discovery_module

    _allow(["alice"])
    _configure(default_session, "guest")

    async def fake_scan():
        return {
            "sonos": [{"name": "Kitchen", "type": "sonos"}],
            "airplay": [],
            "chromecast": [],
            "dlna": [],
        }

    monkeypatch.setattr(discovery_module, "_scan_devices", lambda verbose=False: fake_scan())
    discovery_module._last_scan_completed = 0.0

    body = client.get("/discover").json()
    assert body["sonos"] == []


def test_discover_keeps_a_device_the_restricted_session_still_holds(
    client, default_session, monkeypatch
):
    from routes import discovery as discovery_module

    _allow(["alice"])
    _configure(default_session, "guest")
    claims._claims["chromecast:TV"] = Claim(session_id=default_session.session_id, claimed_at=0.0)

    async def fake_scan():
        return {
            "sonos": [],
            "airplay": [],
            "chromecast": [{"name": "TV", "type": "chromecast"}],
            "dlna": [],
        }

    monkeypatch.setattr(discovery_module, "_scan_devices", lambda verbose=False: fake_scan())
    discovery_module._last_scan_completed = 0.0

    body = client.get("/discover").json()
    assert [d["name"] for d in body["chromecast"]] == ["TV"]
