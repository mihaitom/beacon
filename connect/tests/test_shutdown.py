"""Tests for main.py's lifespan shutdown — stopping any still-active
deliveries so a cast device doesn't keep playing after this backend process
exits, regardless of *why* it's exiting (dev-mode Ctrl+C, the packaged
Electron app quitting, a manual restart, ...)."""

from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from core.session import SessionState, registry
from main import app
from media import SubsonicClient


def test_lifespan_stops_active_delivery_on_shutdown(default_session: SessionState):
    stub_delivery = AsyncMock()
    default_session.state.active_delivery = stub_delivery

    with TestClient(app):
        pass  # startup runs on __enter__, shutdown runs on __exit__

    stub_delivery.stop.assert_awaited_once()


def test_lifespan_ignores_sessions_without_active_delivery(default_session: SessionState):
    assert default_session.state.active_delivery is None
    with TestClient(app):
        pass  # must not raise — nothing to stop


def test_lifespan_stops_every_session_not_just_the_first(default_session: SessionState):
    default_session.state.active_delivery = AsyncMock()

    other = SessionState("other-session")
    other.media = SubsonicClient("")
    other.state.active_delivery = AsyncMock()
    registry._sessions["other-session"] = other

    with TestClient(app):
        pass

    default_session.state.active_delivery.stop.assert_awaited_once()
    other.state.active_delivery.stop.assert_awaited_once()


def test_lifespan_stopping_one_delivery_does_not_block_the_others(
    default_session: SessionState,
):
    default_session.state.active_delivery = AsyncMock()
    default_session.state.active_delivery.stop.side_effect = RuntimeError("device unreachable")

    other = SessionState("other-session")
    other.media = SubsonicClient("")
    other.state.active_delivery = AsyncMock()
    registry._sessions["other-session"] = other

    with TestClient(app):
        pass

    default_session.state.active_delivery.stop.assert_awaited_once()
    other.state.active_delivery.stop.assert_awaited_once()
