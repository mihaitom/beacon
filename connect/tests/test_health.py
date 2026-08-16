"""Tests for GET /health."""

import importlib
from unittest.mock import patch

import pytest


def _reload_devices():
    import routes.devices as devices_mod

    importlib.reload(devices_mod)
    return devices_mod


@pytest.fixture
def server_lock_env(monkeypatch):
    """Reloads routes/devices.py's module-level _SERVER_LOCK/_LOCKED_URLS/
    _LOCKED_LOGIN_URL (computed once at import time from os.environ — see
    that module) against whatever env vars the test itself sets via
    monkeypatch first, then reloads back to a clean (unset) state
    afterwards so later tests — in this file or any other — never see a
    leftover lock from an earlier test."""
    yield
    monkeypatch.delenv("SERVER_LOCK", raising=False)
    monkeypatch.delenv("SERVER_URL", raising=False)
    monkeypatch.delenv("NAVIDROME_INTERNAL_URL", raising=False)
    monkeypatch.delenv("SERVER_TYPE", raising=False)
    _reload_devices()


def test_ffmpeg_found(client):
    with patch("shutil.which", return_value="/usr/bin/ffmpeg"):
        r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ffmpeg"] is True


def test_ffmpeg_missing(client):
    with patch("shutil.which", return_value=None):
        r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ffmpeg"] is False


def test_navidrome_not_configured(client):
    r = client.get("/health")
    assert r.json()["navidrome_configured"] is False


def test_navidrome_configured(client):
    client.post("/config", json={"url": "http://nav:4533", "credential": "token=x"})
    r = client.get("/health")
    assert r.json()["navidrome_configured"] is True


# ── server_lock ──────────────────────────────────────────────────────────────
# ServerLoginView.vue reads this (pre-login — /health needs no authenticated
# session) to skip asking for a server URL entirely once this deployment is
# locked to one specific server via SERVER_LOCK=true.


def test_health_no_server_lock_by_default(client):
    r = client.get("/health")
    assert r.json()["server_lock"] is None


def test_health_reports_server_lock_with_server_url(
    client, monkeypatch, server_lock_env
):
    monkeypatch.setenv("SERVER_LOCK", "true")
    monkeypatch.setenv("SERVER_URL", "https://navidrome.example.com")
    _reload_devices()

    r = client.get("/health")
    assert r.json()["server_lock"] == {
        "url": "https://navidrome.example.com",
        "server_type": "subsonic",
    }


def test_health_server_lock_falls_back_to_internal_url(
    client, monkeypatch, server_lock_env
):
    monkeypatch.setenv("SERVER_LOCK", "true")
    monkeypatch.setenv("NAVIDROME_INTERNAL_URL", "http://navidrome:4533")
    _reload_devices()

    r = client.get("/health")
    assert r.json()["server_lock"]["url"] == "http://navidrome:4533"


def test_health_prefers_server_url_over_internal_url(
    client, monkeypatch, server_lock_env
):
    monkeypatch.setenv("SERVER_LOCK", "true")
    monkeypatch.setenv("SERVER_URL", "https://navidrome.example.com")
    monkeypatch.setenv("NAVIDROME_INTERNAL_URL", "http://navidrome:4533")
    _reload_devices()

    r = client.get("/health")
    assert r.json()["server_lock"]["url"] == "https://navidrome.example.com"


def test_health_no_server_lock_without_any_url(client, monkeypatch, server_lock_env):
    # SERVER_LOCK=true alone, no SERVER_URL/NAVIDROME_INTERNAL_URL to lock to —
    # nothing meaningful to report, same as not being locked at all. Both
    # explicitly unset (not just "not set by this test") since a real dev
    # .env can already have NAVIDROME_INTERNAL_URL set for the actual backend
    # to run against.
    monkeypatch.setenv("SERVER_LOCK", "true")
    monkeypatch.delenv("SERVER_URL", raising=False)
    monkeypatch.delenv("NAVIDROME_INTERNAL_URL", raising=False)
    _reload_devices()

    r = client.get("/health")
    assert r.json()["server_lock"] is None


def test_health_server_url_alone_without_lock_flag_reports_no_lock(
    client, monkeypatch, server_lock_env
):
    # Having SERVER_URL set means nothing on its own — SERVER_LOCK=true is
    # the explicit opt-in that actually turns it into a lock.
    monkeypatch.setenv("SERVER_URL", "https://navidrome.example.com")
    _reload_devices()

    r = client.get("/health")
    assert r.json()["server_lock"] is None


def test_health_server_lock_reports_jellyfin_server_type(
    client, monkeypatch, server_lock_env
):
    monkeypatch.setenv("SERVER_LOCK", "true")
    monkeypatch.setenv("SERVER_URL", "https://jellyfin.example.com")
    monkeypatch.setenv("SERVER_TYPE", "jellyfin")
    _reload_devices()

    r = client.get("/health")
    assert r.json()["server_lock"] == {
        "url": "https://jellyfin.example.com",
        "server_type": "jellyfin",
    }


# ── session_server_type ─────────────────────────────────────────────────────
# What the *currently authenticated* session is actually talking to — unlike
# server_lock above, set (or not) regardless of SERVER_LOCK, since an
# unlocked multi-server deployment still needs to gate Navidrome/Jellyfin-
# specific UI once someone's actually logged in.


def test_health_session_server_type_none_before_login(client):
    r = client.get("/health")
    assert r.json()["session_server_type"] is None


def test_health_session_server_type_subsonic_after_config(client):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    r = client.get("/health")
    assert r.json()["session_server_type"] == "subsonic"


def test_health_session_server_type_jellyfin_after_config(client):
    client.post(
        "/config",
        json={
            "url": "http://jf:8096",
            "credential": "tok",
            "server_type": "jellyfin",
            "user_id": "u1",
        },
    )
    r = client.get("/health")
    assert r.json()["session_server_type"] == "jellyfin"
