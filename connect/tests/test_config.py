"""Tests for POST /config."""

import importlib

import pytest

from media import JellyfinClient, PlexClient, SubsonicClient


def _reload_devices():
    import routes.devices as devices_mod

    importlib.reload(devices_mod)
    return devices_mod


@pytest.fixture
def server_lock_env(monkeypatch):
    """See test_health.py's identical fixture — reloads routes/devices.py's
    module-level SERVER_LOCK state against whatever the test sets via
    monkeypatch, then back to unset afterwards."""
    yield
    monkeypatch.delenv("SERVER_LOCK", raising=False)
    monkeypatch.delenv("SERVER_URL", raising=False)
    monkeypatch.delenv("NAVIDROME_INTERNAL_URL", raising=False)
    monkeypatch.delenv("JELLYFIN_INTERNAL_URL", raising=False)
    monkeypatch.delenv("SERVER_TYPE", raising=False)
    _reload_devices()


def test_config_sets_subsonic_url(client, default_session):
    r = client.post("/config", json={"url": "http://nav:4533", "credential": "token=abc"})
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
    assert isinstance(default_session.media, SubsonicClient)
    assert default_session.media.base_url == "http://nav:4533"


def test_config_updates_credential(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "old"})
    client.post("/config", json={"url": "http://nav:4533", "credential": "new"})
    assert default_session.media._credential == "new"


def test_config_replaces_url(client, default_session):
    client.post("/config", json={"url": "http://old:4533", "credential": "x"})
    client.post("/config", json={"url": "http://new:4533", "credential": "x"})
    assert default_session.media.base_url == "http://new:4533"


def test_config_explicit_subsonic_type(client, default_session):
    r = client.post(
        "/config",
        json={
            "url": "http://nav:4533",
            "credential": "token=abc",
            "server_type": "subsonic",
        },
    )
    assert r.status_code == 200
    assert isinstance(default_session.media, SubsonicClient)


def test_config_jellyfin_type_creates_jellyfin_client(client, default_session):
    r = client.post(
        "/config",
        json={
            "url": "http://jf:8096",
            "credential": "jf-access-token",
            "server_type": "jellyfin",
            "user_id": "user-guid-abc",
        },
    )
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
    assert isinstance(default_session.media, JellyfinClient)
    assert default_session.media.base_url == "http://jf:8096"
    assert default_session.media.token == "jf-access-token"
    assert default_session.media.user_id == "user-guid-abc"


def test_config_plex_type_creates_plex_client(client, default_session):
    r = client.post(
        "/config",
        json={
            "url": "http://plex:32400",
            "credential": "plex-server-token",
            "server_type": "plex",
            "machine_identifier": "machine-abc",
        },
    )
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
    assert isinstance(default_session.media, PlexClient)
    assert default_session.media.base_url == "http://plex:32400"
    assert default_session.media.token == "plex-server-token"
    assert default_session.media.machine_identifier == "machine-abc"


def test_config_switches_between_server_types(client, default_session):
    client.post(
        "/config",
        json={"url": "http://nav:4533", "credential": "x", "server_type": "subsonic"},
    )
    assert isinstance(default_session.media, SubsonicClient)
    client.post(
        "/config",
        json={
            "url": "http://jf:8096",
            "credential": "tok",
            "server_type": "jellyfin",
            "user_id": "u1",
        },
    )
    assert isinstance(default_session.media, JellyfinClient)


def test_config_sets_display_name_from_username(client, default_session):
    client.post(
        "/config",
        json={"url": "http://nav:4533", "credential": "x", "username": "alice"},
    )
    assert default_session.display_name == "alice"


async def test_config_uses_the_newer_calls_result_even_if_its_ping_resolves_first(
    default_session,
):
    """Regression test: two concurrent /config calls for the same session
    (a UI double-submit, a retry racing the original request) each await
    media.ping() (a real network round trip) before applying their result.
    The older call's ping() taking *longer* and resolving after the newer
    one's must not let it win and overwrite the session with stale
    credentials just because it happened to finish last."""
    import asyncio
    import time
    from unittest.mock import patch

    from routes.devices import ConfigRequest, configure

    def _ping(self):
        if self.base_url == "http://old:4533":
            time.sleep(0.1)  # the older request's own credential check is slow
        return True

    with patch.object(SubsonicClient, "ping", new=_ping):
        old_req = ConfigRequest(url="http://old:4533", credential="old-cred")
        old_task = asyncio.create_task(configure(old_req, default_session))
        await asyncio.sleep(0)  # let the older call start (and claim seq=1) first

        new_req = ConfigRequest(url="http://new:4533", credential="new-cred")
        new_task = asyncio.create_task(configure(new_req, default_session))

        await asyncio.gather(old_task, new_task)

    assert default_session.media.base_url == "http://new:4533"
    assert default_session.media._credential == "new-cred"


def test_config_rejects_a_credential_the_media_server_wont_accept(
    client, default_session, monkeypatch
):
    """The shared CONNECT_TOKEN only proves the request came through our own
    nginx — ping() failing means the credential itself isn't a real,
    authenticated media-server user, and must 401 rather than accept it."""
    monkeypatch.setattr(SubsonicClient, "ping", lambda self: False)
    # The `default_session` fixture pre-sets this True (see its own
    # docstring) — reset to False here so the assertion below actually
    # exercises "rejection never flips it True", not just "left at
    # whatever the fixture happened to already have".
    default_session.authenticated = False

    r = client.post("/config", json={"url": "http://nav:4533", "credential": "bad"})

    assert r.status_code == 401
    assert "credential" in r.json()["detail"].lower()
    assert default_session.authenticated is False


# ── internal_url resolution ──────────────────────────────────────────────────


def test_config_subsonic_uses_navidrome_internal_url(
    client, default_session, monkeypatch, server_lock_env
):
    monkeypatch.setenv("NAVIDROME_INTERNAL_URL", "http://nav-internal:4533")
    _reload_devices()

    client.post(
        "/config",
        json={"url": "https://nav.example.com", "credential": "x", "server_type": "subsonic"},
    )
    assert default_session.media.internal_url == "http://nav-internal:4533"


def test_config_jellyfin_ignores_navidrome_internal_url(
    client, default_session, monkeypatch, server_lock_env
):
    # Regression test: /config used to always read NAVIDROME_INTERNAL_URL
    # regardless of server_type, so a Jellyfin session would silently ping
    # whatever Navidrome server NAVIDROME_INTERNAL_URL pointed at instead of
    # the actual Jellyfin server — always rejecting the login, since
    # Navidrome has no /Users/Me endpoint for JellyfinClient.ping() to hit.
    # Jellyfin has its own JELLYFIN_INTERNAL_URL var now (see the test
    # below) — NAVIDROME_INTERNAL_URL specifically must stay Navidrome-only.
    monkeypatch.setenv("NAVIDROME_INTERNAL_URL", "https://navidrome.example.com")
    _reload_devices()

    client.post(
        "/config",
        json={
            "url": "https://jf.example.com",
            "credential": "tok",
            "server_type": "jellyfin",
            "user_id": "u1",
        },
    )
    assert default_session.media.internal_url == "https://jf.example.com"


def test_config_jellyfin_uses_jellyfin_internal_url(
    client, default_session, monkeypatch, server_lock_env
):
    monkeypatch.setenv("JELLYFIN_INTERNAL_URL", "http://jf-internal:8096")
    _reload_devices()

    client.post(
        "/config",
        json={
            "url": "https://jf.example.com",
            "credential": "tok",
            "server_type": "jellyfin",
            "user_id": "u1",
        },
    )
    assert default_session.media.internal_url == "http://jf-internal:8096"


def test_config_plex_ignores_navidrome_internal_url(
    client, default_session, monkeypatch, server_lock_env
):
    # Plex has no internal-URL env var at all (see routes/devices.py's
    # comment) — its address always comes from the login/server-picker URL.
    monkeypatch.setenv("NAVIDROME_INTERNAL_URL", "https://navidrome.example.com")
    _reload_devices()

    client.post(
        "/config",
        json={
            "url": "https://plex.example.com",
            "credential": "tok",
            "server_type": "plex",
        },
    )
    assert default_session.media.internal_url == "https://plex.example.com"


# ── SERVER_LOCK ──────────────────────────────────────────────────────────────


def test_config_rejects_mismatched_url_when_locked(client, monkeypatch, server_lock_env):
    monkeypatch.setenv("SERVER_LOCK", "true")
    monkeypatch.setenv("SERVER_URL", "https://navidrome.example.com")
    _reload_devices()

    r = client.post(
        "/config",
        json={"url": "https://someone-elses-server.example.com", "credential": "x"},
    )
    assert r.status_code == 403


def test_config_accepts_matching_url_when_locked(
    client, default_session, monkeypatch, server_lock_env
):
    monkeypatch.setenv("SERVER_LOCK", "true")
    monkeypatch.setenv("SERVER_URL", "https://navidrome.example.com")
    _reload_devices()

    r = client.post("/config", json={"url": "https://navidrome.example.com", "credential": "x"})
    assert r.status_code == 200
    assert default_session.media.base_url == "https://navidrome.example.com"


def test_config_unenforced_when_lock_flag_unset(client, monkeypatch, server_lock_env):
    # SERVER_URL alone (no SERVER_LOCK=true) must not restrict anything —
    # see _LOCKED_LOGIN_URL's comment in routes/devices.py.
    monkeypatch.setenv("SERVER_URL", "https://navidrome.example.com")
    _reload_devices()

    r = client.post("/config", json={"url": "http://anything-else:4533", "credential": "x"})
    assert r.status_code == 200
