"""Tests for POST /config."""

from media import JellyfinClient, SubsonicClient


def test_config_sets_subsonic_url(client, default_session):
    r = client.post(
        "/config", json={"url": "http://nav:4533", "credential": "token=abc"}
    )
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
