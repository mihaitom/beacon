"""Shared fixtures for Connect API tests."""

import ipaddress

import pytest
from fastapi.testclient import TestClient

from core import auth, state
from core import claims as claims_module
from core import remote as remote_module
from core import session as session_module
from core.session import DEFAULT_SESSION_ID, SessionState
from main import app
from media import JellyfinClient, PlexClient, SubsonicClient
from routes import discovery as discovery_module


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
def _block_real_sonos_discovery(monkeypatch):
    """soco.discover() is a real, unmocked network-wide SSDP multicast search
    (see delivery/sonos.py's _get_device() docstring) — on a LAN that also
    has real Sonos hardware on it, an uncovered call reaches actual
    speakers, not a fake one.

    Confirmed live 2026-08-24: a /resume regression test in test_playback.py
    uses the real production room name "Arbeitszimmer" for its
    active_delivery and only mocks SonosDelivery.play — the position-resync
    background tasks that /resume's handler schedules (_apply_position_offset,
    _resync_position_periodically) are not covered by that mock and call the
    real, unmocked get_position() for as long as the test process runs. The
    dev machine and the production Sonos speakers share the same /24, so
    this reached the real device; the user reproduced it directly (fresh
    playback started, test suite run, playback stopped immediately).

    Every test that legitimately needs a device patches soco.discover or
    SonosDelivery._get_device itself, which shadows this default for its own
    scope — this fixture only closes the gap for whatever a test forgot to
    cover, so a forgotten mock fails fast (no device found) instead of
    silently reaching real hardware."""
    monkeypatch.setattr("soco.discover", lambda *args, **kwargs: None)


@pytest.fixture(autouse=True)
def _clear_sonos_device_cache():
    """delivery/sonos.py caches resolved SoCo devices process-wide (see
    _get_device()), so without this one test's fake speaker would still be
    cached for the next one — and a test that patched soco.discover would
    silently never reach it."""
    from delivery.sonos import forget_cached_devices

    forget_cached_devices()
    yield
    forget_cached_devices()


@pytest.fixture(autouse=True)
def _stub_media_ping(monkeypatch):
    """/config now calls media.ping() to verify the supplied credential
    actually authenticates before accepting it (see routes/devices.py) — but
    most tests exercise it with fake URLs (e.g. http://nav:4533) that don't
    resolve to a real server. Stub just the three ping() methods (not the
    underlying httpx.get, which get_track()/get_cover_art_url() etc. also
    use and tests mock separately) to succeed by default; tests that
    specifically exercise ping()'s own behavior (test_subsonic.py,
    test_jellyfin.py, test_plex.py) or /config rejection override this with
    their own monkeypatch.setattr call."""
    monkeypatch.setattr(SubsonicClient, "ping", lambda self: True)
    monkeypatch.setattr(JellyfinClient, "ping", lambda self: True)
    monkeypatch.setattr(PlexClient, "ping", lambda self: True)


@pytest.fixture(autouse=True)
def _stub_output_format(monkeypatch):
    """/play resolves the real output format for the track it's about to
    dispatch (see core/streamer.py's resolve_output_format()), which shells
    out to a real ffmpeg subprocess against the track's source URL — not
    something the rest of the playback test suite should have to account
    for. Stub it to return the existing mp3 fallback instantly; tests that
    specifically exercise format detection (test_streamer.py) override this
    themselves."""
    from core.streamer import FALLBACK_FORMAT

    async def _fake_resolve(url, gain=1.0, **kwargs):
        return FALLBACK_FORMAT

    monkeypatch.setattr("routes.playback.resolve_output_format", _fake_resolve)


@pytest.fixture(autouse=True)
def _stub_stream_probe(monkeypatch):
    """/play-url asks the station itself what it sends and whether it is
    serving at all (see core/stream_format.py) — a real HTTP request to
    whatever URL a test happens to use. Left unstubbed, the suite reaches
    out to the internet: `https://example.com/stream.mp3`, which most
    playback tests use as a stand-in, really does answer 404, and every one
    of them started failing on a station that "refused the connection".

    Stubbed to the same answer the pre-probe code would have guessed from
    the URL's extension, so tests that don't care about formats behave as
    they always did. Tests that exercise probing itself
    (test_stream_format.py) call it directly, and the ones about /play-url's
    own handling of it override this fixture.

    Deliberately not a network *block*: the point is one predictable answer,
    not a failure a test would then have to interpret."""
    from core.stream_format import ProbedStream, content_type_from_extension

    async def _fake_probe(url, client=None):
        return ProbedStream(content_type_from_extension(url))

    monkeypatch.setattr("routes.playback.probe_stream", _fake_probe)


@pytest.fixture(autouse=True)
def _isolate_radio_title_history(tmp_path, monkeypatch):
    """core/radio_history.py stores each session's radio title log under
    CONNECT_DATA_DIR so it outlives a restart and a reap (see its own
    docstring). Same reasoning as _isolate_radio_favicon_disk_cache below:
    unisolated, a test run writes real files into the developer's checkout
    and — worse here, since the log is keyed by session id and every test
    shares DEFAULT_SESSION_ID — hands the next test the titles this one
    recorded."""
    monkeypatch.setattr("core.radio_history._DIR", str(tmp_path / "radio-history"))


@pytest.fixture(autouse=True)
def _isolate_radio_favicon_disk_cache(tmp_path, monkeypatch):
    """routes/radio.py keeps resolved station logos in a directory under
    CONNECT_DATA_DIR so they survive a restart (see its _disk_store()). In
    a test run that directory is the developer's own checkout, and the
    module resolved its path at import time, before any test could point it
    somewhere else.

    So every test gets its own empty one. Same reasoning as
    _block_real_sonos_discovery above: a test that forgets to isolate this
    would otherwise write real files into the working tree and hand the
    *next* test a populated cache, which is exactly the kind of pass that
    means nothing."""
    monkeypatch.setattr("routes.radio._DISK_DIR", str(tmp_path / "radio-favicons"))
    monkeypatch.setattr("routes.radio._disk_loaded", False)
    monkeypatch.setattr("routes.radio._disk_bytes", 0)


@pytest.fixture(autouse=True)
def reset_state():
    """Wipe all runtime state before each test so tests are isolated: the
    session registry (all per-user playback state), the claim registry, the
    global device-discovery cache, and Remote Control state."""
    session_module.registry._sessions.clear()
    claims_module.claims._claims.clear()
    state.ctx.discovered = {"airplay": [], "chromecast": [], "dlna": [], "sonos": []}
    # has_cache (GET /discover) is keyed off this, not off ctx.discovered's
    # contents above — a test leaving it at a real timestamp from an
    # earlier scan would make a later test's /discover call believe a scan
    # had already completed and serve the (just-reset, empty) cache instead
    # of actually running the mocked discover_*() functions that test set up.
    discovery_module._last_scan_completed = 0.0
    discovery_module._consecutive_failures = {
        "sonos": 0,
        "airplay": 0,
        "chromecast": 0,
        "dlna": 0,
    }
    remote_module.remote.disable()
    remote_module.remote._attempts.clear()
    remote_module.remote._lockout_until.clear()
    remote_module.remote._lockout_strikes.clear()
    yield


def _reaches_real_hardware(host: str) -> bool:
    """True for anything a raw socket.connect() could use to reach an
    actual device on this LAN.

    Every delivery class in this codebase (Sonos, DLNA, Chromecast,
    AirPlay) addresses a device by the literal IP discovery handed back,
    never a hostname - so a private or link-local unicast address is where
    real hardware in the room actually lives, and a multicast address is
    SSDP/mDNS, the protocols those same devices are discovered over. A
    public address is categorically not a device on this network, no
    matter what it is: core/state.py's get_local_ip() connects to one
    (8.8.8.8) purely to read back the outbound interface's own address via
    getsockname(), a standard trick that works because a UDP connect()
    only consults the local routing table - it never actually puts a
    packet on the wire, so there is nothing there to protect against.

    A bare hostname (not a literal IP) is blocked by the same conservative
    default as before it: nothing in this codebase's device path ever
    produces one, so a test reaching one is almost always a forgotten
    mock, not a real device - no reason to start trusting it now."""
    if host == "localhost":
        return False
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return True
    if addr.is_loopback:
        return False
    return addr.is_private or addr.is_link_local or addr.is_multicast or addr.is_reserved


@pytest.fixture(autouse=True)
def _no_real_device_network(monkeypatch):
    """Fail any attempt to open a socket to a real device on this LAN, for
    every test in the suite.

    The dev machine shares its /24 with real Sonos, AirPlay and DLNA
    hardware, and the suite drives the very code whose job is to talk to
    them. _block_real_sonos_discovery above closes one hole - soco's SSDP
    search - but a delivery that already has an address reaches it over
    plain HTTP without going through discovery at all: DlnaDelivery's SOAP
    calls, SonosDelivery.get_position(), the UPnP subscription renewals.
    Any of those left uncovered by a test's own mocks lands on the
    speaker that is actually playing music in the room. Reported live
    2026-08-24 (playback stopped the moment the suite ran) and again
    2026-09-03 (audible dropouts that tracked pytest runs).

    Scoped to what _reaches_real_hardware() above actually calls a device
    (private/link-local/multicast) rather than every non-loopback address:
    an earlier version blocked outbound sockets wholesale, which also
    caught core/state.py's get_local_ip() - a harmless local-routing-table
    UDP trick that never reaches the network at all - and broke the app's
    own startup (main.py's lifespan) under every test using the `client`
    fixture. Reported live 2026-09-03.

    Sockets rather than any one HTTP client, because there are several in
    play (httpx, soco's own requests, pychromecast) and they all end up
    here. Loopback stays open: TestClient's ASGI transport doesn't use a
    socket at all, but some libraries still open one to talk to
    themselves, and nothing there can reach the network.

    A test that legitimately needs a connection this still blocks should
    mock the call it is exercising - that is what this makes unmissable,
    by failing loudly instead of quietly reaching hardware."""
    import socket

    real_connect = socket.socket.connect

    def _guarded(self, address, *args, **kwargs):
        host = address[0] if isinstance(address, tuple) else address
        if isinstance(host, str) and not _reaches_real_hardware(host):
            return real_connect(self, address, *args, **kwargs)
        raise AssertionError(
            f"test tried to open a socket to {host!r} — real hardware lives on this "
            "network; mock the call being exercised instead"
        )

    monkeypatch.setattr(socket.socket, "connect", _guarded)


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
