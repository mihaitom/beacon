"""Tests for core/api_keys.py and routes/api_keys.py — the installation-wide
key store every external service uses, and the route Settings drives it
through."""

import logging
import os
import stat

import pytest

from core import api_keys


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path, monkeypatch):
    """An isolated store directory and a clean cache for every test."""
    monkeypatch.setattr(api_keys, "_DATA_DIR", str(tmp_path))
    api_keys._cache.clear()
    yield
    api_keys._cache.clear()


@pytest.fixture
def env_key(monkeypatch):
    monkeypatch.setenv("LASTFM_API_KEY", "test-key")
    api_keys._cache.clear()
    yield
    api_keys._cache.clear()


@pytest.fixture
def no_key(monkeypatch):
    monkeypatch.delenv("LASTFM_API_KEY", raising=False)
    api_keys._cache.clear()
    yield
    api_keys._cache.clear()


# ── storage ──────────────────────────────────────────────────────────────────


def test_a_stored_key_wins_over_the_environment(env_key):
    """Settings has to be able to override a Docker deployment's variable,
    otherwise the field appears to do nothing there."""
    assert api_keys.get("lastfm") == "test-key"
    api_keys.set("lastfm", "from-settings")
    assert api_keys.get("lastfm") == "from-settings"


def test_clearing_a_stored_key_falls_back_to_the_environment(env_key):
    """Not to "no key at all" — clearing the field in a Docker deployment
    should return to the variable it was started with, not switch the
    feature off in a way nothing in the UI could explain."""
    api_keys.set("lastfm", "from-settings")
    api_keys.set("lastfm", "")
    assert api_keys.get("lastfm") == "test-key"
    assert api_keys.is_configured("lastfm") is True


def test_clearing_a_stored_key_with_no_environment_leaves_nothing(no_key):
    api_keys.set("lastfm", "from-settings")
    api_keys.set("lastfm", "")
    assert api_keys.is_configured("lastfm") is False


def test_a_new_key_takes_effect_without_a_restart():
    """The whole reason the key isn't read at import time: Settings can
    change it while the process runs."""
    api_keys.set("lastfm", "first")
    assert api_keys.get("lastfm") == "first"
    api_keys.set("lastfm", "second")
    assert api_keys.get("lastfm") == "second"


def test_a_stored_key_survives_a_fresh_process():
    api_keys.set("lastfm", "from-settings")
    # What a restart looks like from this module's point of view: the cache
    # is gone, the file is not.
    api_keys._cache.clear()
    assert api_keys.get("lastfm") == "from-settings"


def test_surrounding_whitespace_is_not_part_of_the_key():
    # Pasting a key out of a browser routinely brings a newline with it,
    # and an upstream API rejects the whole request for it.
    api_keys.set("lastfm", "  padded-key\n")
    assert api_keys.get("lastfm") == "padded-key"


def test_stored_ignores_the_environment(env_key):
    assert api_keys.stored("lastfm") == ""
    api_keys.set("lastfm", "from-settings")
    assert api_keys.stored("lastfm") == "from-settings"


def test_an_unreadable_store_does_not_take_the_environment_down(env_key, tmp_path, caplog):
    """A directory where the file should be — get() still has to answer, so
    the feature keeps working off the environment's key."""
    os.makedirs(tmp_path / "lastfm_api_key.txt")
    with caplog.at_level(logging.WARNING, logger="connect.api_keys"):
        assert api_keys.get("lastfm") == "test-key"


def test_a_hand_written_key_file_may_end_in_a_newline():
    """`echo key > lastfm_api_key.txt` is a plausible way to set this on a
    server, and the trailing newline would otherwise go into every request."""
    with open(api_keys._path("lastfm"), "w", encoding="utf-8") as f:
        f.write("hand-written-key\n")
    api_keys._cache.clear()

    assert api_keys.get("lastfm") == "hand-written-key"


def test_the_key_file_is_not_readable_by_other_accounts():
    """A shared NAS or a multi-user box would otherwise hand the key to
    every other account on it - the default umask leaves a new file
    world-readable."""
    api_keys.set("lastfm", "from-settings")
    mode = stat.S_IMODE(os.stat(api_keys._path("lastfm")).st_mode)

    assert mode & (stat.S_IRGRP | stat.S_IROTH | stat.S_IWGRP | stat.S_IWOTH) == 0
    assert mode & stat.S_IRUSR


def test_replacing_a_key_keeps_the_restricted_mode():
    api_keys.set("lastfm", "first")
    api_keys.set("lastfm", "second")
    mode = stat.S_IMODE(os.stat(api_keys._path("lastfm")).st_mode)

    assert mode & (stat.S_IRGRP | stat.S_IROTH) == 0
    assert api_keys.get("lastfm") == "second"


def test_each_service_has_its_own_file(no_key):
    api_keys.set("lastfm", "one")
    api_keys.set("fanart", "two")
    assert api_keys.get("lastfm") == "one"
    assert api_keys.get("fanart") == "two"


# ── routes/api_keys.py ───────────────────────────────────────────────────────


def test_get_reports_every_service(client, no_key):
    body = client.get("/api-keys").json()
    assert set(body["keys"]) == set(api_keys.SERVICES)
    assert body["keys"]["lastfm"] == {"configured": False, "fromEnvironment": False}


def test_posting_a_key_configures_the_service(client, no_key):
    resp = client.post("/api-keys/lastfm", json={"key": "from-settings"})

    assert resp.status_code == 200
    assert resp.json()["keys"]["lastfm"] == {"configured": True, "fromEnvironment": False}
    assert api_keys.get("lastfm") == "from-settings"


def test_posting_an_empty_key_clears_it(client, no_key):
    client.post("/api-keys/lastfm", json={"key": "from-settings"})
    resp = client.post("/api-keys/lastfm", json={"key": ""})
    assert resp.json()["keys"]["lastfm"]["configured"] is False


def test_status_says_when_the_key_came_from_the_environment(client, env_key):
    """Settings shows an empty field either way; this is what keeps a
    Docker deployment from reading as unconfigured."""
    assert client.get("/api-keys").json()["keys"]["lastfm"] == {
        "configured": True,
        "fromEnvironment": True,
    }
    client.post("/api-keys/lastfm", json={"key": "from-settings"})
    assert client.get("/api-keys").json()["keys"]["lastfm"]["fromEnvironment"] is False


def test_the_key_itself_is_never_sent_back(client, no_key):
    api_keys.set("lastfm", "secret-key")
    assert "secret-key" not in client.get("/api-keys").text


def test_an_unknown_service_is_a_404(client, no_key):
    """The service name is a filename underneath - only the registry's own
    names may reach it."""
    resp = client.post("/api-keys/not-a-service", json={"key": "x"})
    assert resp.status_code == 404
