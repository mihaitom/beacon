"""Shared fixtures for Connect API tests."""

import ipaddress
import socket
from typing import ClassVar

import pytest
from fastapi.testclient import TestClient

from core import auth, state
from core import claims as claims_module
from core import party as party_module
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


def _is_local(host) -> bool:
    if host in (None, "", "localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@pytest.fixture(autouse=True)
def _block_real_network(monkeypatch):
    """No test opens a connection to the internet or the LAN. A radio test
    posted http://example.com/stream.mp3 unmocked, and the relay behind
    /play-url connected to it for real (found 2026-09-27). Refused here
    straight away instead, with the same exceptions a real failure raises,
    so such a test behaves the same everywhere and a new leak shows up on
    the first local run. Multicast discovery is blocked separately, below.

    Loopback stays open (the test client and asyncio use it), and so does
    UDP: get_local_ip() "connects" a datagram socket only to read which
    interface the route goes through, which sends nothing."""
    real_getaddrinfo = socket.getaddrinfo
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex

    def getaddrinfo(host, *args, **kwargs):
        if isinstance(host, bytes):
            host = host.decode()
        if _is_local(host):
            return real_getaddrinfo(host, *args, **kwargs)
        try:
            ipaddress.ip_address(host)
        except ValueError:
            raise socket.gaierror(socket.EAI_NONAME, f"test run: no DNS for {host}") from None
        return real_getaddrinfo(host, *args, **kwargs)  # a literal address, no lookup

    def _refuse(sock, address) -> bool:
        return (
            sock.family in (socket.AF_INET, socket.AF_INET6)
            and sock.type & socket.SOCK_STREAM
            and not _is_local(address[0])
        )

    def connect(sock, address):
        if _refuse(sock, address):
            raise ConnectionRefusedError(f"test run: no connection to {address[0]}")
        return real_connect(sock, address)

    def connect_ex(sock, address):
        if _refuse(sock, address):
            return 111  # ECONNREFUSED
        return real_connect_ex(sock, address)

    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)


class _NoCastBrowser:
    devices: ClassVar[dict] = {}


@pytest.fixture(autouse=True)
def _block_real_cast_and_dlna_discovery(monkeypatch):
    """The Chromecast and DLNA counterparts of the soco.discover() block
    below. A delivery that does not know its device yet goes looking for it
    on the network - Chromecast over mDNS, waiting at least 3s; DLNA over an
    SSDP search, 5s - and that includes stop(), which the app's shutdown
    calls for every session still casting. So a test that merely left a
    cast "playing" searched the real network for a device of that name while
    tearing down, and would have stopped it had there been one. Found
    2026-09-27 behind a CI timeout.

    Tests that exercise discovery patch these same names themselves, which
    takes precedence."""
    from delivery import chromecast, manager

    for module in (chromecast, manager):
        monkeypatch.setattr(
            module, "_ensure_cast_browser", lambda: (_NoCastBrowser(), None), raising=False
        )
        monkeypatch.setattr(module, "_wait_for_discovery", lambda *a, **k: None, raising=False)

    async def no_ssdp_search(*args, **kwargs):
        return None

    monkeypatch.setattr("async_upnp_client.search.async_search", no_ssdp_search)


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
def _isolated_client_ids(monkeypatch, tmp_path):
    """media/client_id.py caches the Jellyfin/Plex ids process-wide and saves
    them to disk — point both at this test's own directory so no test writes
    next to the code or sees another test's id."""
    from core import client_id

    monkeypatch.setattr(client_id, "_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(client_id, "_LEGACY_DIR", str(tmp_path / "legacy"))
    client_id.forget_cached_ids()
    yield
    client_id.forget_cached_ids()


@pytest.fixture(autouse=True)
def _isolated_integration_key(monkeypatch, tmp_path):
    """No integration key unless a test makes one, and never next to the code."""
    from core import integration_key

    monkeypatch.setattr(integration_key, "_DATA_DIR", str(tmp_path / "data"))
    integration_key.forget_cached()
    yield
    integration_key.forget_cached()


class _FakeZeroconf:
    """Records what core/mdns.py would announce instead of sending it."""

    registered: ClassVar[list] = []

    def __init__(self, *args, **kwargs):
        pass

    async def async_register_service(self, info, **kwargs):
        _FakeZeroconf.registered.append(info)

    async def async_unregister_service(self, info):
        _FakeZeroconf.registered.remove(info)

    async def async_close(self):
        pass


@pytest.fixture(autouse=True)
def fake_zeroconf(monkeypatch):
    """A test run must never announce anything on the real network."""
    from core import mdns

    _FakeZeroconf.registered = []
    monkeypatch.setattr(mdns, "AsyncZeroconf", _FakeZeroconf)
    monkeypatch.setattr(mdns, "_zeroconf", None)
    monkeypatch.setattr(mdns, "_info", None)
    return _FakeZeroconf


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

    Only the direct-to-device path still probes; a relayed station learns
    the same thing from the relay's own connection, which
    _stub_relay_station_fetch below is the equivalent stub for.

    Deliberately not a network *block*: the point is one predictable answer,
    not a failure a test would then have to interpret."""
    from core.stream_format import ProbedStream, content_type_from_extension

    async def _fake_probe(url, client=None):
        return ProbedStream(content_type_from_extension(url))

    monkeypatch.setattr("routes.playback.probe_stream", _fake_probe)


@pytest.fixture(autouse=True)
def _stub_relay_station_fetch(monkeypatch):
    """core/radio_relay.py connects to the station the moment a relay is
    started — the default for both /play-url and /stream/radio-local — and
    that connection is now also where the station's own content type and
    any refusal come from (see _stub_stream_probe above). Left unstubbed,
    the suite fetches whatever station URL a test happens to name, for real.

    Stubbed to "could not be reached", which every route already handles:
    /play-url falls back to dispatching the station directly, exactly the
    behaviour tests that set no relay up were written against.

    Patched on the relay's own httpx client rather than on _run_once, so a
    test that substitutes its own station (test_radio_relay.py patches this
    very attribute, test_radio_reencode.py patches _run_once) still takes
    precedence over it — this is the floor, not a ceiling."""
    import httpx

    from core import radio_relay as relay_mod

    def _unreachable(*args, **kwargs):
        raise httpx.ConnectError("stubbed: tests do not fetch real stations")

    monkeypatch.setattr(relay_mod._client, "stream", _unreachable)


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
def _isolate_radio_station_info_cache(tmp_path, monkeypatch):
    """core/radio_station_info.py keeps Radio Browser's answers in a file
    under CONNECT_DATA_DIR, resolved at import time - same reasoning as the
    two fixtures around this one."""
    monkeypatch.setattr("core.radio_station_info._PATH", str(tmp_path / "station-info.json"))
    monkeypatch.setattr("core.radio_station_info._cache", None)
    monkeypatch.setattr("core.radio_station_info._resolved", {})


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
    remote_module.remote.renderer_connected = False
    remote_module.remote._attempts.clear()
    remote_module.remote._lockout_until.clear()
    remote_module.remote._lockout_strikes.clear()
    party_module.party.disable()
    party_module.party.streams.clear()
    party_module.party.streams_per_ip.clear()
    party_module.party.host_session_id = None
    party_module.party.current_song_id = None
    party_module.party.settings = party_module.Settings()
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
def _no_real_device_network(monkeypatch, request):
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
    by failing loudly instead of quietly reaching hardware.

    The one exception is the `live` suites, whose entire purpose is a real
    connection to a real server on this LAN (test_bridges_live.py: a
    Jellyfin, Plex or Navidrome the developer actually runs). Mocking the
    call there would delete the test. They are excluded from the default
    run by `-m 'not live'` in pyproject.toml, so this only opens up when
    someone asks for them by name - and none of them talks to a speaker,
    which is what this guard exists to protect."""
    if request.node.get_closest_marker("live"):
        return

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
