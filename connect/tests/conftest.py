"""Shared fixtures for Connect API tests."""

import pytest
from fastapi.testclient import TestClient

from core import auth
from core import claims as claims_module
from core import session as session_module
from core import state
from core.session import DEFAULT_SESSION_ID, SessionState
from main import app
from media import JellyfinClient, SubsonicClient


@pytest.fixture
def client():
    """Synchronous TestClient — no network, no real devices needed.

    Automatically includes X-Connect-Token when CONNECT_TOKEN is set so tests
    pass regardless of whether token auth is enabled in the environment. No
    X-Connect-Session header is set, so every request made through this
    client lands in the single DEFAULT_SESSION_ID session — same as the old
    single-global-session behavior. See the `default_session` fixture below.
    """
    with TestClient(app) as c:
        if auth.TOKEN:
            c.headers.update({"X-Connect-Token": auth.TOKEN})
        yield c


@pytest.fixture(autouse=True)
def _stub_media_ping(monkeypatch):
    """/config now calls media.ping() to verify the supplied credential
    actually authenticates before accepting it (see routes/devices.py) — but
    most tests exercise it with fake URLs (e.g. http://nav:4533) that don't
    resolve to a real server. Stub just the two ping() methods (not the
    underlying httpx.get, which get_track()/get_cover_art_url() etc. also
    use and tests mock separately) to succeed by default; tests that
    specifically exercise ping()'s own behavior (test_subsonic.py,
    test_jellyfin.py) or /config rejection override this with their own
    monkeypatch.setattr call."""
    monkeypatch.setattr(SubsonicClient, "ping", lambda self: True)
    monkeypatch.setattr(JellyfinClient, "ping", lambda self: True)


@pytest.fixture(autouse=True)
def reset_state():
    """Wipe all runtime state before each test so tests are isolated: the
    session registry (all per-user playback state), the claim registry, and
    the global device-discovery cache."""
    session_module.registry._sessions.clear()
    claims_module.claims._claims.clear()
    state.ctx.discovered = {"airplay": [], "chromecast": [], "dlna": [], "sonos": []}
    yield


@pytest.fixture
def default_session(reset_state) -> SessionState:
    """The SessionState any request through `client` (no X-Connect-Session
    header) resolves to — direct equivalent of the old `state.ctx.state`/
    `state.ctx.media` for tests written against the pre-multi-user single
    global session. Depends on reset_state explicitly so it's inserted into
    the registry *after* that fixture clears it, not before."""
    session = SessionState(DEFAULT_SESSION_ID)
    session.media = SubsonicClient("")
    session.authenticated = True
    session_module.registry._sessions[DEFAULT_SESSION_ID] = session
    return session
