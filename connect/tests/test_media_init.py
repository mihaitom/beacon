"""Tests for media/__init__.py's server_type_name() — the one place that
knows the isinstance mapping used by both /health (routes/devices.py) and
the proxy bridge dispatch (routes/proxy.py) — and resolve_account(), which
/config uses to learn the verified media-server account behind a
credential."""

import asyncio

from media import (
    JellyfinClient,
    PlexClient,
    ResolvedAccount,
    SubsonicClient,
    resolve_account,
    server_type_name,
)


def test_server_type_name_jellyfin():
    assert server_type_name(JellyfinClient("http://jf:8096")) == "jellyfin"


def test_server_type_name_plex():
    assert server_type_name(PlexClient("http://plex:32400")) == "plex"


def test_server_type_name_subsonic():
    assert server_type_name(SubsonicClient("http://nav:4533")) == "subsonic"


def test_resolve_account_reads_the_subsonic_user(monkeypatch):
    client = SubsonicClient("http://nav:4533", credential="u=alice")
    monkeypatch.setattr(
        client,
        "get_user",
        lambda username: {"username": "alice", "adminRole": True},
    )

    assert asyncio.run(resolve_account(client, "alice")) == ResolvedAccount("alice", True, True)


def test_resolve_account_reads_the_jellyfin_user(monkeypatch):
    async def fake_get_user(params, media):
        return {"user": {"username": "bob", "adminRole": False}}

    monkeypatch.setattr("media.jellyfin_bridge.get_user", fake_get_user)

    account = asyncio.run(resolve_account(JellyfinClient("http://jf:8096")))
    assert account == ResolvedAccount("bob", False, True)


def test_resolve_account_leaves_plex_unverified_but_names_the_server(monkeypatch):
    """Plex cannot resolve the account name from the server token — that is
    /config's job, with the account token (see routes/devices.py). The admin
    flag is still real, and the server is named by its own identifier."""

    async def fake_get_user(params, media):
        return {"user": {"username": "", "adminRole": True}}

    async def fake_machine_identifier(media):
        return "machine-abc"

    monkeypatch.setattr("media.plex_bridge.get_user", fake_get_user)
    monkeypatch.setattr("media.plex_bridge.machine_identifier", fake_machine_identifier)

    account = asyncio.run(resolve_account(PlexClient("http://plex:32400")))
    assert account == ResolvedAccount("", True, False, "plex://machine-abc")


def test_resolve_account_survives_a_plex_server_that_hides_its_identity(monkeypatch):
    async def fake_get_user(params, media):
        return {"user": {"username": "", "adminRole": False}}

    async def failing_machine_identifier(media):
        raise RuntimeError("no answer")

    monkeypatch.setattr("media.plex_bridge.get_user", fake_get_user)
    monkeypatch.setattr("media.plex_bridge.machine_identifier", failing_machine_identifier)

    account = asyncio.run(resolve_account(PlexClient("http://plex:32400")))
    assert account == ResolvedAccount("", False, False, "")
