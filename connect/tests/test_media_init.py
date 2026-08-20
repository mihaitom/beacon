"""Tests for media/__init__.py's server_type_name() — the one place that
knows the isinstance mapping used by both /health (routes/devices.py) and
the proxy bridge dispatch (routes/proxy.py)."""

from media import JellyfinClient, PlexClient, SubsonicClient, server_type_name


def test_server_type_name_jellyfin():
    assert server_type_name(JellyfinClient("http://jf:8096")) == "jellyfin"


def test_server_type_name_plex():
    assert server_type_name(PlexClient("http://plex:32400")) == "plex"


def test_server_type_name_subsonic():
    assert server_type_name(SubsonicClient("http://nav:4533")) == "subsonic"
