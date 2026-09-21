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


def test_resolve_account_leaves_plex_unverified(monkeypatch):
    """Plex cannot resolve the account name from the server token — the user
    list lives at plex.tv and needs the account token (see
    docs/cast-permissions.md). The admin flag is still real."""

    async def fake_get_user(params, media):
        return {"user": {"username": "", "adminRole": True}}

    monkeypatch.setattr("media.plex_bridge.get_user", fake_get_user)

    account = asyncio.run(resolve_account(PlexClient("http://plex:32400")))
    assert account == ResolvedAccount("", True, False)
