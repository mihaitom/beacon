"""lights/: the Hue bridge client, the DTLS stream, the analysis, the show,
the controller that decides when it runs, and routes/lights.py."""

from __future__ import annotations

import asyncio
import io
import os
import shutil
import socket
import struct
import subprocess
import time
from typing import ClassVar

import httpx
import numpy as np
import pytest

from core.beat_analysis import ANALYSIS_RATE, BeatGrid
from core.session import SessionState, registry
from lights import analysis, hue, show
from lights import config as lights_config
from lights.analysis import SongLights
from lights.controller import (
    LOCAL_REPORT_TTL,
    ROTATION_SECONDS,
    LightController,
    Source,
    hex_colour,
    palette_for,
    to_hex,
)
from media.base import Track

AREA = "e86ec01f-145f-4ea3-bdc3-02d28439ab0a"
LEFT = hue.Channel(0, -0.5, 0.0, 0.0)
RIGHT = hue.Channel(1, 0.5, 0.0, 0.0)
RED = (1.0, 0.0, 0.0)
BLUE = (0.0, 0.0, 1.0)


def _paired(**overrides) -> lights_config.LightsConfig:
    values = {
        "bridge_host": "10.0.0.2",
        "bridge_id": "001788fffe000001",
        "username": "user",
        "clientkey": "00112233445566778899aabbccddeeff",
        "app_id": "app-id",
        "area_id": AREA,
        "enabled": True,
    }
    values.update(overrides)
    return lights_config.update(**values)


# ── stream message ───────────────────────────────────────────────────────


def test_stream_message_follows_the_huestream_v2_layout():
    msg = hue.stream_message(7, AREA, {0: (1.0, 0.5, 0.0), 3: (0.0, 0.0, 1.0)})
    assert msg[:9] == b"HueStream"
    assert msg[9:11] == bytes([2, 0])  # version 2.0
    assert msg[11] == 7  # sequence
    assert msg[14] == 0  # RGB colour space
    assert msg[16:52] == AREA.encode()
    channels = [struct.unpack(">BHHH", msg[52 + i * 7 : 59 + i * 7]) for i in range(2)]
    assert channels == [(0, 0xFFFF, 0x8000, 0), (3, 0, 0, 0xFFFF)]
    assert len(msg) == 52 + 2 * 7


def test_stream_message_clamps_and_wraps():
    msg = hue.stream_message(300, AREA, {0: (2.0, -1.0, 0.5)})
    assert msg[11] == 300 & 0xFF
    assert struct.unpack(">BHHH", msg[52:59])[1:3] == (0xFFFF, 0)


# ── DTLS ─────────────────────────────────────────────────────────────────


def _free_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.mark.skipif(shutil.which("openssl") is None, reason="needs the openssl CLI")
def test_dtls_stream_reaches_a_psk_server_with_hues_cipher():
    """The exact handshake the bridge wants - DTLS 1.2, PSK, AES-128-GCM -
    against OpenSSL's own server, and the payload arrives."""
    key = "00112233445566778899aabbccddeeff"
    port = _free_udp_port()
    server = subprocess.Popen(
        [
            "openssl", "s_server", "-dtls1_2", "-nocert", "-quiet",
            "-psk", key, "-psk_identity", "beacon-app",
            "-cipher", "PSK-AES128-GCM-SHA256", "-accept", str(port),
        ],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )  # fmt: skip
    try:
        time.sleep(0.3)
        stream = hue.DtlsStream("127.0.0.1", "beacon-app", bytes.fromhex(key), port=port)
        stream.handshake(timeout=10)
        stream.send(b"hello-bridge\n")
        time.sleep(0.3)
        stream.close()
    finally:
        server.kill()
        out = server.communicate(timeout=5)[0]
    assert b"hello-bridge" in out


@pytest.mark.skipif(shutil.which("openssl") is None, reason="needs the openssl CLI")
def test_dtls_stream_fails_cleanly_on_a_wrong_key():
    port = _free_udp_port()
    server = subprocess.Popen(
        [
            "openssl", "s_server", "-dtls1_2", "-nocert", "-quiet",
            "-psk", "ffeeddccbbaa99887766554433221100", "-psk_identity", "beacon-app",
            "-cipher", "PSK-AES128-GCM-SHA256", "-accept", str(port),
        ],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )  # fmt: skip
    try:
        time.sleep(0.3)
        stream = hue.DtlsStream("127.0.0.1", "beacon-app", bytes(16), port=port)
        with pytest.raises(hue.HueError):
            stream.handshake(timeout=3)
        stream.close()
    finally:
        server.kill()
        server.communicate(timeout=5)


# ── bridge HTTP ──────────────────────────────────────────────────────────


@pytest.fixture
def bridge_http(monkeypatch):
    """Routes every bridge request to a handler instead of the network, and
    records the TLS settings each client was made with."""
    real = httpx.AsyncClient
    seen = {"verify": [], "requests": []}
    handlers: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["requests"].append(request)
        for (method, path), reply in handlers.items():
            if request.method == method and request.url.path == path:
                return reply(request) if callable(reply) else reply
        return httpx.Response(404)

    def factory(*args, verify=True, **kwargs):
        seen["verify"].append(verify)
        return real(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(hue.httpx, "AsyncClient", factory)
    return handlers, seen


async def test_identify_reads_the_bridge_id_over_a_ca_verified_connection(bridge_http):
    handlers, seen = bridge_http
    handlers[("GET", "/api/0/config")] = httpx.Response(200, json={"bridgeid": "001788FFFE298911"})
    bridge = await hue.identify("10.0.0.2")
    assert bridge == hue.Bridge("10.0.0.2", "001788fffe298911")
    ctx = seen["verify"][0]
    # The CA is checked even though the name cannot be yet.
    assert ctx.verify_mode.name == "CERT_REQUIRED"


async def test_identify_raises_for_something_else(bridge_http):
    with pytest.raises(hue.HueError):
        await hue.identify("10.0.0.3")


async def test_pair_waits_for_the_button_then_returns_the_keys(bridge_http):
    handlers, seen = bridge_http
    bridge = hue.Bridge("10.0.0.2", "001788fffe000001")
    handlers[("POST", "/api")] = httpx.Response(
        200, json=[{"error": {"type": 101, "description": "link button not pressed"}}]
    )
    with pytest.raises(hue.LinkButtonNotPressedError):
        await hue.pair(bridge, "connect")

    handlers[("POST", "/api")] = httpx.Response(
        200, json=[{"success": {"username": "u1", "clientkey": "AB" * 16}}]
    )
    handlers[("GET", "/auth/v1")] = httpx.Response(200, headers={"hue-application-id": "app-1"})
    pairing = await hue.pair(bridge, "connect")
    assert pairing == hue.Pairing("u1", "AB" * 16, "app-1")
    assert seen["requests"][-1].headers["hue-application-key"] == "u1"
    # Every authenticated request checks the certificate against the id.
    assert all(ctx.check_hostname for ctx in seen["verify"])


async def test_pair_surfaces_other_refusals(bridge_http):
    handlers, _ = bridge_http
    handlers[("POST", "/api")] = httpx.Response(
        200, json=[{"error": {"type": 7, "description": "invalid value"}}]
    )
    with pytest.raises(hue.HueError) as e:
        await hue.pair(hue.Bridge("10.0.0.2", "x"), "connect")
    assert not isinstance(e.value, hue.LinkButtonNotPressedError)


async def test_list_areas_and_start_stop(bridge_http):
    handlers, seen = bridge_http
    handlers[("GET", "/clip/v2/resource/entertainment_configuration")] = httpx.Response(
        200,
        json={
            "data": [
                {
                    "id": AREA,
                    "metadata": {"name": "Office"},
                    "status": "inactive",
                    "channels": [
                        {"channel_id": 0, "position": {"x": -0.3, "y": 0.2, "z": 1.0}},
                        {"channel_id": 1, "position": {"x": 0.1, "y": 0.9, "z": -0.5}},
                    ],
                }
            ]
        },
    )
    handlers[("PUT", f"/clip/v2/resource/entertainment_configuration/{AREA}")] = httpx.Response(
        200, json={"data": []}
    )
    bridge, pairing = hue.Bridge("10.0.0.2", "id"), hue.Pairing("u", "k", "a")
    [area] = await hue.list_areas(bridge, pairing)
    assert area.name == "Office"
    assert [c.channel_id for c in area.channels] == [0, 1]
    assert area.channels[0].x == -0.3
    assert not area.active

    await hue.set_streaming(bridge, pairing, AREA, True)
    await hue.set_streaming(bridge, pairing, AREA, False)
    bodies = [r.content for r in seen["requests"] if r.method == "PUT"]
    assert bodies == [b'{"action":"start"}', b'{"action":"stop"}']


async def test_get_area_raises_for_an_unknown_area(bridge_http):
    handlers, _ = bridge_http
    handlers[("GET", "/clip/v2/resource/entertainment_configuration/nope")] = httpx.Response(
        200, json={"data": []}
    )
    with pytest.raises(hue.HueError):
        await hue.get_area(hue.Bridge("h", "id"), hue.Pairing("u", "k", "a"), "nope")


# ── analysis ─────────────────────────────────────────────────────────────


def _click_track(bpm: float, seconds: float) -> np.ndarray:
    out = np.zeros(int(seconds * ANALYSIS_RATE), dtype=np.float32)
    n = int(0.02 * ANALYSIS_RATE)
    t = np.arange(n) / ANALYSIS_RATE
    click = np.sin(2 * np.pi * 80 * t) * np.exp(-t / 0.01)
    for beat in range(int(seconds * bpm / 60)):
        start = int(beat * 60 / bpm * ANALYSIS_RATE)
        out[start : start + n] += click[: len(out) - start] * (1.0 if beat % 4 == 0 else 0.6)
    return out


def test_a_steady_beat_gets_a_grid_at_its_tempo():
    song = analysis.analyse_samples_for_lights(_click_track(120, 30))
    assert song.grid is not None
    assert song.grid.bpm == pytest.approx(120, rel=0.02)
    assert song.duration == pytest.approx(30, abs=0.01)


def test_noise_gets_no_grid():
    rng = np.random.default_rng(1)
    song = analysis.analyse_samples_for_lights(
        (rng.standard_normal(ANALYSIS_RATE * 20) * 0.2).astype(np.float32)
    )
    assert song.grid is None


def test_energy_curve_follows_the_loud_section():
    quiet = np.full(ANALYSIS_RATE * 10, 0.05, dtype=np.float32)
    loud = np.full(ANALYSIS_RATE * 10, 0.5, dtype=np.float32)
    curve = analysis.energy_curve(np.concatenate([quiet, loud]))
    assert len(curve) == 20 * analysis.ENERGY_RATE
    assert curve[5] < 0.2
    assert curve[-5] == pytest.approx(1.0)


def test_energy_curve_of_silence_and_of_nothing():
    assert not analysis.energy_curve(np.zeros(ANALYSIS_RATE * 2, dtype=np.float32)).any()
    assert len(analysis.energy_curve(np.zeros(10, dtype=np.float32))) == 0


def _png(colour: tuple[int, int, int]) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (40, 40), colour).save(buf, format="PNG")
    return buf.getvalue()


def _striped_png(*colours: tuple[int, int, int], widths: tuple[int, ...] | None = None) -> bytes:
    from PIL import Image

    widths = widths or (10,) * len(colours)
    img = Image.new("RGB", (sum(widths), 30))
    x = 0
    for colour, width in zip(colours, widths, strict=True):
        img.paste(colour, (x, 0, x + width, 30))
        x += width
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_the_palette_takes_the_cover_hue_at_full_value():
    ((r, g, b),) = analysis.cover_palette(_png((120, 20, 20)))
    assert r == pytest.approx(1.0)
    assert g < 0.3 and b < 0.3


def test_the_palette_lists_different_colours_strongest_first():
    palette = analysis.cover_palette(
        _striped_png((200, 30, 30), (30, 60, 200), (30, 180, 60), widths=(20, 10, 5))
    )
    assert len(palette) == 3
    red, blue, green = palette
    assert red[0] == pytest.approx(1.0)
    assert blue[2] == pytest.approx(1.0)
    assert green[1] == pytest.approx(1.0)


def test_shades_of_one_colour_are_one_palette_entry():
    # Red and an orange 36 degrees away: neighbours, not two colours.
    palette = analysis.cover_palette(_striped_png((200, 20, 20), (220, 140, 20), (128, 128, 128)))
    assert len(palette) == 1


def test_a_grey_cover_falls_back_to_warm_white():
    assert analysis.cover_palette(_png((128, 128, 128))) == (analysis.DEFAULT_COLOUR,)


async def test_cover_colours_without_a_cover():
    assert await analysis.cover_colours(None) == (analysis.DEFAULT_COLOUR,)


async def test_analysis_cache_runs_once_and_remembers_failures(monkeypatch):
    calls = []

    async def fake_decode(url):
        calls.append(url)
        return None if "bad" in url else _click_track(120, 10)

    monkeypatch.setattr(analysis, "_decode", fake_decode)
    cache = analysis.AnalysisCache()
    cache.request("a", "http://good")
    cache.request("a", "http://good")
    cache.request("b", "http://bad")
    for _ in range(100):
        if cache.has("a") and cache.has("b"):
            break
        await asyncio.sleep(0.02)
    assert calls == ["http://good", "http://bad"]
    assert cache.get("a") is not None
    assert cache.get("b") is None and cache.has("b")
    cache.request("b", "http://bad")
    await asyncio.sleep(0.05)
    assert calls == ["http://good", "http://bad"]


async def _settled(cache: analysis.AnalysisCache) -> None:
    for _ in range(100):
        if not cache._running:
            return
        await asyncio.sleep(0.01)


async def test_a_failed_decode_is_tried_again_later_a_few_times(monkeypatch):
    calls = []

    async def fake_decode(url):
        calls.append(url)

    monkeypatch.setattr(analysis, "_decode", fake_decode)
    cache = analysis.AnalysisCache()
    for _ in range(analysis._DECODE_ATTEMPTS + 2):
        cache.request("a", "http://flaky")
        await _settled(cache)
        cache.request("a", "http://flaky")  # too soon: no second decode
        await _settled(cache)
        cache._failed["a"] = (cache._failed["a"][0], 0.0)  # the wait is over
    assert len(calls) == analysis._DECODE_ATTEMPTS


async def test_a_decode_that_works_on_the_second_go_is_kept(monkeypatch):
    results = [None, _click_track(120, 10)]

    async def fake_decode(url):
        return results.pop(0)

    monkeypatch.setattr(analysis, "_decode", fake_decode)
    cache = analysis.AnalysisCache()
    cache.request("a", "http://flaky")
    await _settled(cache)
    cache._failed["a"] = (1, 0.0)
    cache.request("a", "http://flaky")
    await _settled(cache)
    assert cache.get("a") is not None
    assert "a" not in cache._failed


async def test_a_failing_analysis_is_not_tried_again(monkeypatch):
    calls = []

    async def fake_decode(url):
        calls.append(url)
        return _click_track(120, 10)

    def broken(samples):
        raise ValueError("no")

    monkeypatch.setattr(analysis, "_decode", fake_decode)
    monkeypatch.setattr(analysis, "analyse_samples_for_lights", broken)
    cache = analysis.AnalysisCache()
    cache.request("a", "http://x")
    await _settled(cache)
    cache._failed["a"] = (cache._failed["a"][0], 0.0)
    cache.request("a", "http://x")
    await _settled(cache)
    assert len(calls) == 1


async def test_only_the_start_of_a_long_song_is_decoded(monkeypatch):
    seen = []

    async def fake_exec(*args, **kwargs):
        seen.extend(args)
        raise OSError("no ffmpeg here")

    monkeypatch.setattr(analysis.asyncio, "create_subprocess_exec", fake_exec)
    assert await analysis._decode("http://music/long") is None
    assert "-t" in seen
    assert float(seen[seen.index("-t") + 1]) == analysis.MAX_ANALYSED_SECONDS


async def test_a_cover_that_cannot_be_fetched_is_worth_another_try(monkeypatch):
    real = httpx.AsyncClient

    def factory(**kwargs):
        kwargs.pop("follow_redirects", None)
        return real(transport=httpx.MockTransport(lambda r: httpx.Response(503)))

    monkeypatch.setattr(analysis.httpx, "AsyncClient", factory)
    assert await analysis.cover_colours("http://music/cover/c1") is None


# ── show ─────────────────────────────────────────────────────────────────


def _song(energy: float = 0.5, grid: BeatGrid | None = None) -> SongLights:
    if grid is None:
        grid = BeatGrid(
            period=0.5, phase=0.0, downbeat=0.0, confidence=1.0, downbeat_confidence=1.0
        )
    return SongLights(
        duration=60, grid=grid, energy=np.full(60 * analysis.ENERGY_RATE, energy, np.float32)
    )


def _level(rgb) -> float:
    return max(rgb)


def test_a_beat_flashes_and_fades_before_the_next():
    song = _song()
    on_beat = show.frame(0.5, song, (RED,), (LEFT,))[0]
    before_next = show.frame(0.95, song, (RED,), (LEFT,))[0]
    assert _level(on_beat) > _level(before_next) + 0.2


def test_the_downbeat_is_stronger_and_whiter():
    song = _song(energy=0.3)
    downbeat = show.frame(2.0, song, (RED,), (LEFT,))[0]
    other = show.frame(2.5, song, (RED,), (LEFT,))[0]
    assert _level(downbeat) >= _level(other)
    assert downbeat[1] > 0  # white mixed into pure red
    assert other[1] == 0


def test_louder_sections_are_brighter():
    quiet = show.frame(0.95, _song(energy=0.1), (RED,), (LEFT,))[0]
    loud = show.frame(0.95, _song(energy=1.0), (RED,), (LEFT,))[0]
    assert _level(loud) > _level(quiet)


def test_left_and_right_take_turns():
    song = _song()
    beat1 = show.frame(0.5, song, (RED,), (LEFT, RIGHT))
    beat2 = show.frame(1.0, song, (RED,), (LEFT, RIGHT))
    assert _level(beat1[1]) > _level(beat1[0])
    assert _level(beat2[0]) > _level(beat2[1])
    # Both sides on the downbeat.
    downbeat = show.frame(2.0, song, (RED,), (LEFT, RIGHT))
    assert _level(downbeat[0]) == pytest.approx(_level(downbeat[1]))


def test_lights_on_one_side_all_pulse():
    song = _song()
    other_left = hue.Channel(2, -0.2, 0, 0)
    beat1 = show.frame(0.5, song, (RED,), (LEFT, other_left))
    assert _level(beat1[0]) == pytest.approx(_level(beat1[2]))


def test_no_beat_follows_loudness_only():
    song = SongLights(duration=10, grid=None, energy=np.array([0.0, 1.0], np.float32))
    quiet = show.frame(0.0, song, (RED,), (LEFT,))[0]
    loud = show.frame(0.3, song, (RED,), (LEFT,))[0]
    assert _level(loud) > _level(quiet)
    # No flashing: steady within the same section.
    assert show.frame(0.26, song, (RED,), (LEFT,))[0] == loud


def test_waiting_for_the_analysis_shows_the_colour_steadily():
    a = show.frame(0.0, None, (RED,), (LEFT, RIGHT))
    b = show.frame(7.3, None, (RED,), (LEFT, RIGHT))
    assert a == b
    assert 0 < _level(a[0]) < 1


@pytest.mark.parametrize("style", show.STYLES)
def test_every_value_stays_in_range(style):
    song = _song(energy=1.0)
    for t in np.linspace(0, 10, 200):
        for rgb in show.frame(float(t), song, ((1.0, 1.0, 1.0),), (LEFT, RIGHT), style).values():
            assert all(0.0 <= c <= 1.0 for c in rgb)


def test_brightness_scales_everything():
    song = _song()
    full = show.frame(0.5, song, (RED,), (LEFT, RIGHT))
    half = show.frame(0.5, song, (RED,), (LEFT, RIGHT), brightness=0.5)
    for cid in full:
        assert _level(half[cid]) == pytest.approx(_level(full[cid]) / 2)


def test_a_palette_is_spread_over_the_lights_from_the_left():
    # Given right first, to show the order comes from the room, not the list.
    lights = show.frame(0.95, _song(), (RED, BLUE), (RIGHT, LEFT))
    assert lights[LEFT.channel_id][0] > 0 and lights[LEFT.channel_id][2] == 0
    assert lights[RIGHT.channel_id][2] > 0 and lights[RIGHT.channel_id][0] == 0


def test_calm_does_not_flash():
    song = _song(energy=0.5)
    levels = [_level(show.frame(t, song, (RED,), (LEFT,), "calm")[0]) for t in (0.5, 0.6, 0.95)]
    assert max(levels) == pytest.approx(min(levels))
    louder = show.frame(0.5, _song(energy=1.0), (RED,), (LEFT,), "calm")[0]
    assert _level(louder) > levels[0]


def test_calm_glides_between_the_palette_colours():
    song = _song()
    start = show.frame(0.0, song, (RED, BLUE), (LEFT,), "calm")[0]
    halfway = show.frame(4.0, song, (RED, BLUE), (LEFT,), "calm")[0]
    assert start[2] == 0
    assert halfway[0] > 0 and halfway[2] > 0


def test_party_swaps_colours_every_beat_and_whitens_the_downbeat():
    song = _song()
    beat1 = show.frame(0.5, song, (RED, BLUE), (LEFT, RIGHT), "party")
    beat2 = show.frame(1.0, song, (RED, BLUE), (LEFT, RIGHT), "party")
    assert (beat1[LEFT.channel_id][0] > 0) != (beat2[LEFT.channel_id][0] > 0)
    downbeat = show.frame(2.0, song, (RED,), (LEFT,), "party")[0]
    assert downbeat[1] > 0 and downbeat[2] > 0


def test_party_with_one_colour_still_has_two():
    song = _song()
    beat1 = show.frame(0.5, song, (RED,), (LEFT,), "party")[0]
    beat2 = show.frame(1.0, song, (RED,), (LEFT,), "party")[0]
    assert beat1.index(max(beat1)) != beat2.index(max(beat2))


def test_party_hits_harder_than_pulse():
    song = _song()

    def contrast(style):
        return _level(show.frame(0.5, song, (RED,), (LEFT,), style)[0]) - _level(
            show.frame(0.95, song, (RED,), (LEFT,), style)[0]
        )

    assert contrast("party") > contrast("pulse")


def test_the_wave_reaches_the_left_light_first():
    song = _song()
    middle = hue.Channel(2, 0.0, 0.0, 0.0)
    just_after = show.frame(0.51, song, (RED,), (RIGHT, middle, LEFT), "wave")
    assert _level(just_after[LEFT.channel_id]) > _level(just_after[2])
    assert _level(just_after[2]) >= _level(just_after[RIGHT.channel_id])
    later = show.frame(0.5 + 0.23, song, (RED,), (RIGHT, middle, LEFT), "wave")
    assert _level(later[RIGHT.channel_id]) > _level(later[LEFT.channel_id])


def test_blend():
    assert show.blend((0, 0, 0), (1, 1, 1), 0.25) == (0.25, 0.25, 0.25)
    assert show.blend((0, 0, 0), (1, 1, 1), 3) == (1, 1, 1)


# ── config ───────────────────────────────────────────────────────────────


def test_config_round_trip_and_file_mode():
    assert not lights_config.get().paired
    cfg = _paired(lead_ms=120, style="party", colour_mode="fixed", fixed_colour="#ff0000")
    assert cfg.ready
    lights_config.reset_cache_for_tests()
    again = lights_config.get()
    assert again == cfg
    path = os.path.join(lights_config._DATA_DIR, "hue_lights.json")
    assert os.stat(path).st_mode & 0o777 == 0o600


def test_config_is_not_ready_without_an_area_or_switched_off():
    assert not _paired(area_id="").ready
    assert not _paired(enabled=False).ready


def test_forget_drops_everything():
    _paired()
    lights_config.forget()
    assert lights_config.get() == lights_config.LightsConfig()
    lights_config.reset_cache_for_tests()
    assert not lights_config.get().paired


def test_a_malformed_file_reads_as_unpaired():
    os.makedirs(lights_config._DATA_DIR, exist_ok=True)
    with open(os.path.join(lights_config._DATA_DIR, "hue_lights.json"), "w") as f:
        f.write("[1, 2]")
    assert lights_config.get() == lights_config.LightsConfig()


def test_unknown_keys_in_the_file_are_ignored():
    os.makedirs(lights_config._DATA_DIR, exist_ok=True)
    with open(os.path.join(lights_config._DATA_DIR, "hue_lights.json"), "w") as f:
        f.write('{"bridge_host": "h", "from_the_future": 1, "style": "wave"}')
    cfg = lights_config.get()
    assert cfg.bridge_host == "h"
    assert cfg.style == "wave"


# ── controller: what to follow ───────────────────────────────────────────


class SonosDelivery:
    def __init__(self, target: str) -> None:
        self.target = target


@pytest.fixture
def sessions(reset_state):
    yield registry
    registry._sessions.clear()


def _casting(session_id: str, speaker: str, song_id: str = "song-1") -> SessionState:
    session = SessionState(session_id)
    st = session.state
    st.is_streaming = True
    st.current_track = Track(id=song_id, title="t", artist="a", duration=200)
    st.active_delivery = SonosDelivery(speaker)
    st.clock.start(10.0)
    registry._sessions[session_id] = session
    return session


def test_follows_a_cast_to_any_speaker(sessions):
    _paired()
    _casting("s1", "Kitchen")
    source = LightController().current_source()
    assert source is not None
    assert (source.session_id, source.song_id) == ("s1", "song-1")
    assert source.position == pytest.approx(10.0, abs=0.5)


def test_a_session_without_a_speaker_is_no_cast(sessions):
    _paired()
    _casting("s1", "Kitchen").state.active_delivery = None
    assert LightController().current_source() is None


def test_ignores_a_paused_cast_and_radio(sessions):
    _paired()
    paused = _casting("s1", "Living Room")
    paused.state.clock.pause(12.0)
    radio = _casting("s2", "Living Room")
    radio.state.radio_info = {"url": "http://station"}
    radio.state.current_track = None
    assert LightController().current_source() is None


def test_nothing_while_switched_off(sessions):
    _paired(enabled=False)
    _casting("s1", "Living Room")
    assert LightController().current_source() is None


def test_local_playback_counts_while_reported(sessions):
    _paired()
    c = LightController()
    c.report_local("phone", "song-9", 30.0, True)
    source = c.current_source()
    assert (source.session_id, source.song_id) == ("phone", "song-9")
    assert source.position == pytest.approx(30.0, abs=0.1)


def test_local_playback_paused_or_gone_quiet_does_not(sessions, monkeypatch):
    _paired()
    c = LightController()
    c.report_local("phone", "song-9", 30.0, False)
    assert c.current_source() is None
    c.report_local("phone", "song-9", 30.0, True)
    c._local["phone"].at -= LOCAL_REPORT_TTL + 1
    assert c.current_source() is None
    c.report_local("phone", "song-9", 30.0, True)
    c.forget_local("phone")
    assert c.current_source() is None


def test_local_position_moves_on_between_reports(sessions):
    _paired()
    c = LightController()
    c.report_local("phone", "song-9", 30.0, True)
    c._local["phone"].at -= 2.0
    assert c.current_source().position == pytest.approx(32.0, abs=0.1)


def test_a_cast_wins_over_local_playback(sessions):
    _paired()
    _casting("s1", "Living Room")
    c = LightController()
    c.report_local("desk", "song-9", 30.0, True)
    assert c.current_source().session_id == "s1"


def test_of_two_casts_the_newer_one(sessions):
    _paired()
    older = _casting("s1", "Living Room", "old")
    older.state.clock.play_start_time -= 60
    _casting("s2", "Kitchen", "new")
    assert LightController().current_source().song_id == "new"


# ── controller: the stream ───────────────────────────────────────────────


class FakeStream:
    instances: ClassVar[list[FakeStream]] = []
    fail_handshake = False
    fail_send = False

    def __init__(self, host, identity, key, port=hue.STREAM_PORT):
        self.sent: list[bytes] = []
        self.closed = False
        FakeStream.instances.append(self)

    def handshake(self, timeout=5.0):
        if FakeStream.fail_handshake:
            raise hue.HueError("no answer")

    def send(self, payload):
        if FakeStream.fail_send:
            raise ConnectionRefusedError("bridge gone")
        self.sent.append(payload)

    def close(self):
        self.closed = True


@pytest.fixture
def fake_bridge(monkeypatch):
    FakeStream.instances = []
    FakeStream.fail_handshake = False
    FakeStream.fail_send = False
    calls: list[tuple[str, bool]] = []

    async def get_area(bridge, pairing, area_id):
        return hue.Area(area_id, "Office", (LEFT, RIGHT), False)

    async def set_streaming(bridge, pairing, area_id, on):
        calls.append((area_id, on))

    monkeypatch.setattr(hue, "get_area", get_area)
    monkeypatch.setattr(hue, "set_streaming", set_streaming)
    monkeypatch.setattr(hue, "DtlsStream", FakeStream)
    return calls


async def test_streams_while_there_is_something_to_follow(sessions, fake_bridge):
    _paired()
    c = LightController()
    c._song_meta["song-9"] = ("", None)  # skip the lookup
    c.report_local("desk", "song-9", 5.0, True)
    await c._tick()
    assert c.streaming
    assert fake_bridge == [(AREA, True)]
    await asyncio.sleep(0.1)
    sent = FakeStream.instances[0].sent
    assert len(sent) >= 3
    assert sent[0][16:52] == AREA.encode()
    await c.stop()
    assert FakeStream.instances[0].closed
    assert fake_bridge[-1] == (AREA, False)


async def test_keeps_streaming_through_a_short_gap_then_stops(sessions, fake_bridge, monkeypatch):
    _paired()
    c = LightController()
    c._song_meta["song-9"] = ("", None)
    c.report_local("desk", "song-9", 5.0, True)
    await c._tick()
    c.report_local("desk", "song-9", 5.0, False)
    await c._tick()
    assert c.streaming
    c._last_seen_source -= 10
    await c._tick()
    assert not c.streaming
    assert fake_bridge[-1] == (AREA, False)
    await c.stop()


async def test_a_failed_start_waits_before_trying_again(sessions, fake_bridge):
    _paired()
    FakeStream.fail_handshake = True
    c = LightController()
    c._song_meta["song-9"] = ("", None)
    c.report_local("desk", "song-9", 5.0, True)
    await c._tick()
    assert not c.streaming
    assert c.last_error
    # The area was handed back after the failed handshake.
    assert fake_bridge == [(AREA, True), (AREA, False)]
    await c._tick()
    assert len(FakeStream.instances) == 1
    FakeStream.fail_handshake = False
    c._retry_after = 0
    await c._tick()
    assert c.streaming
    assert c.last_error is None
    await c.stop()


async def test_a_changed_setting_does_not_wait_out_a_failed_start(sessions, fake_bridge):
    _paired()
    FakeStream.fail_handshake = True
    c = LightController()
    c._song_meta["song-9"] = ("", None)
    c.report_local("desk", "song-9", 5.0, True)
    await c._tick()
    assert not c.streaming
    FakeStream.fail_handshake = False
    lights_config.update(area_id="other-area")
    c.retry_now()
    await c._tick()
    assert c.streaming
    await c.stop()


async def test_a_dead_render_loop_hands_the_area_back_and_starts_again(sessions, fake_bridge):
    _paired()
    c = LightController()
    c._song_meta["song-9"] = ("", None)
    c.report_local("desk", "song-9", 5.0, True)
    await c._tick()
    FakeStream.fail_send = True
    await asyncio.sleep(0.05)
    await c._tick()
    assert not c.streaming
    assert c.last_error
    assert fake_bridge[-1] == (AREA, False)
    FakeStream.fail_send = False
    c._retry_after = 0
    await c._tick()
    assert c.streaming
    assert len(FakeStream.instances) == 2
    await c.stop()


async def test_switching_off_stops_the_stream(sessions, fake_bridge):
    _paired()
    c = LightController()
    c._song_meta["song-9"] = ("", None)
    c.report_local("desk", "song-9", 5.0, True)
    await c._tick()
    lights_config.update(enabled=False)
    await c._tick()
    assert not c.streaming
    await c.stop()


async def test_a_new_area_restarts_the_stream_there(sessions, fake_bridge):
    _paired()
    c = LightController()
    c._song_meta["song-9"] = ("", None)
    c.report_local("desk", "song-9", 5.0, True)
    await c._tick()
    lights_config.update(area_id="other-area")
    await c._tick()
    assert fake_bridge == [(AREA, True), (AREA, False), ("other-area", True)]
    await c.stop()


def test_frame_uses_the_song_position_plus_the_lead(sessions):
    _paired(lead_ms=100)
    c = LightController()
    c._channels = (LEFT,)
    c._palette = (RED,)
    c._covers["s"] = (RED,)
    c._analysis._done["s"] = _song()
    now = time.monotonic()
    # 0.4 s in plus 0.1 s lead lands on the beat at 0.5.
    c._source, c._source_at = Source("x", "s", 0.4), now
    on_beat = c._frame(now)[0]
    c._source, c._source_at = Source("x", "s", 0.3), now
    before = c._frame(now)[0]
    assert _level(on_beat) > _level(before)


async def test_resolve_finds_stream_and_colour(sessions, monkeypatch):
    session = SessionState("s1")
    registry._sessions["s1"] = session

    class Media:
        def get_stream_url(self, song_id):
            return f"http://music/{song_id}"

        def get_track(self, song_id):
            return Track(id=song_id, title="t", artist="a", duration=1, cover_art_id="c1")

        def get_cover_art_url(self, cover_id, internal=False, size=300):
            assert internal
            return f"http://music/cover/{cover_id}"

    session.media = Media()

    async def colours(url):
        assert url == "http://music/cover/c1"
        return (RED, BLUE)

    monkeypatch.setattr("lights.controller.cover_colours", colours)
    c = LightController()
    await c._resolve(Source("s1", "song-1", 0.0))
    assert c._song_meta["song-1"] == ("http://music/song-1", "http://music/cover/c1")
    assert c._covers["song-1"] == (RED, BLUE)


class _Media:
    def __init__(self, fail_times: int = 0):
        self.fail_times = fail_times
        self.lookups = 0

    def get_stream_url(self, song_id):
        self.lookups += 1
        if self.lookups <= self.fail_times:
            raise ConnectionError("server away")
        return f"http://music/{song_id}"

    def get_track(self, song_id):
        return Track(id=song_id, title="t", artist="a", duration=1, cover_art_id="c1")

    def get_cover_art_url(self, cover_id, internal=False, size=300):
        return f"http://music/cover/{cover_id}"


async def _resolved(c: LightController, song_id: str) -> None:
    for _ in range(100):
        await asyncio.sleep(0.01)
        if song_id not in c._song_meta_pending:
            return


async def test_a_failed_lookup_is_tried_again_after_a_while(sessions, monkeypatch):
    _paired()
    session = SessionState("s1")
    registry._sessions["s1"] = session
    session.media = _Media(fail_times=1)

    async def colours(url):
        return (RED,)

    monkeypatch.setattr("lights.controller.cover_colours", colours)
    c = LightController()
    source = Source("s1", "song-1", 0.0)
    c._prepare(source)
    await _resolved(c, "song-1")
    assert "song-1" not in c._song_meta
    c._prepare(source)  # too soon
    await _resolved(c, "song-1")
    assert session.media.lookups == 1
    c._lookup_retry["song-1"] = 0.0
    c._prepare(source)
    await _resolved(c, "song-1")
    assert c._song_meta["song-1"] == ("http://music/song-1", "http://music/cover/c1")
    assert c._covers["song-1"] == (RED,)
    c._analysis.cancel_all()


async def test_a_missing_cover_does_not_hold_back_the_beat(sessions, monkeypatch):
    _paired()
    session = SessionState("s1")
    registry._sessions["s1"] = session
    session.media = _Media()
    answers = [None, (BLUE,)]

    async def colours(url):
        return answers.pop(0)

    requested = []
    monkeypatch.setattr("lights.controller.cover_colours", colours)
    c = LightController()
    monkeypatch.setattr(c._analysis, "request", lambda song_id, url: requested.append(url))
    source = Source("s1", "song-1", 0.0)
    c._prepare(source)
    await _resolved(c, "song-1")
    assert "song-1" not in c._covers
    c._prepare(source)
    # The stream is known, so the analysis goes ahead without the colour.
    assert requested == ["http://music/song-1"]
    c._lookup_retry["song-1"] = 0.0
    c._prepare(source)
    await _resolved(c, "song-1")
    assert c._covers["song-1"] == (BLUE,)
    assert session.media.lookups == 1  # only the cover was fetched again


async def test_the_dialog_sees_the_colours_of_the_last_song_followed(sessions, fake_bridge):
    _paired()
    c = LightController()
    assert c.picture_palette is None
    c._song_meta["song-9"] = ("", None)
    c._covers["song-9"] = (RED, BLUE)
    c.report_local("desk", "song-9", 5.0, True)
    await c._tick()
    c.forget_local("desk")
    await c._tick()
    # Still there after the song stopped.
    assert c.picture_palette == (RED, BLUE)
    await c.stop()


GREEN = (0.0, 1.0, 0.0)
PICTURE = "https://assets.fanart.tv/fanart/music/x/artistbackground/a.jpg"


async def _picture_loaded(c: LightController, url: str) -> None:
    for _ in range(100):
        if c._picture_colours.get(url) is not None:
            return
        await asyncio.sleep(0.01)


async def test_an_artist_picture_in_the_foreground_gives_the_colours(sessions, monkeypatch):
    async def colours(url):
        assert url == PICTURE
        return (GREEN,)

    monkeypatch.setattr("lights.controller.fanart_colours", colours)
    c = LightController()
    c._covers["s"] = (RED, BLUE)
    assert c._palette_of("s") == (RED, BLUE)
    c.set_picture("s", PICTURE)
    await _picture_loaded(c, PICTURE)
    assert c._palette_of("s") == (GREEN,)
    # Another song keeps its own cover.
    c._covers["t"] = (BLUE,)
    assert c._palette_of("t") == (BLUE,)
    # Back to the cover when the app shows it again.
    c.set_picture("s", None)
    assert c._palette_of("s") == (RED, BLUE)


def test_the_show_fades_towards_the_pictures_colours(sessions):
    _paired()
    c = LightController()
    c._channels = (LEFT,)
    c._palette = (RED,)
    c._covers["s"] = (BLUE,)
    c._pictures["s"] = PICTURE
    c._picture_colours[PICTURE] = (GREEN,)
    c._source, c._source_at = Source("x", "s", 0.0), time.monotonic()
    c._frame(time.monotonic())
    ((_, g, b),) = c._palette
    assert g > 0 and b == 0


async def test_a_picture_that_cannot_be_had_leaves_the_cover(sessions, monkeypatch):
    async def colours(url):
        return None

    monkeypatch.setattr("lights.controller.fanart_colours", colours)
    c = LightController()
    c._covers["s"] = (RED,)
    c.set_picture("s", PICTURE)
    await asyncio.sleep(0.02)
    assert c._palette_of("s") == (RED,)


async def test_a_picture_is_looked_at_once(sessions, monkeypatch):
    calls = []

    async def colours(url):
        calls.append(url)
        return (GREEN,)

    monkeypatch.setattr("lights.controller.fanart_colours", colours)
    c = LightController()
    c.set_picture("s", PICTURE)
    c.set_picture("t", PICTURE)
    await _picture_loaded(c, PICTURE)
    c.set_picture("s", PICTURE)
    await asyncio.sleep(0.02)
    assert calls == [PICTURE]


async def test_fanart_colours_come_from_connects_image_store(monkeypatch):
    from core import fanart

    monkeypatch.setattr(fanart, "get_cached_image", lambda url: _png((20, 160, 20)))
    ((r, g, _),) = await analysis.fanart_colours(PICTURE)
    assert g == pytest.approx(1.0) and r < 0.3


async def test_fanart_colours_fetch_what_is_not_stored_yet(monkeypatch):
    from core import fanart

    stored = {}

    async def fetch(url):
        return _png((20, 20, 160)), "image/png"

    monkeypatch.setattr(fanart, "get_cached_image", lambda url: None)
    monkeypatch.setattr(fanart, "fetch_image", fetch)
    monkeypatch.setattr(fanart, "store_image", lambda url, data: stored.update({url: data}))
    ((*_, b),) = await analysis.fanart_colours(PICTURE)
    assert b == pytest.approx(1.0)
    assert PICTURE in stored


def test_hex_round_trip():
    assert to_hex((1.0, 0.5, 0.0)) == "#ff8000"
    assert hex_colour("#ff8000") == pytest.approx((1.0, 128 / 255, 0.0))
    assert hex_colour("nonsense") == analysis.DEFAULT_COLOUR


def test_the_settings_pick_the_colours():
    cover = (RED, BLUE)
    assert palette_for(_paired(colour_mode="cover"), cover) == (RED,)
    assert palette_for(_paired(colour_mode="palette"), cover) == (RED, BLUE)
    assert palette_for(_paired(colour_mode="fixed", fixed_colour="#0000ff"), cover) == (BLUE,)
    # The cover not looked at yet.
    assert palette_for(_paired(colour_mode="palette"), None) == (analysis.DEFAULT_COLOUR,)


def test_rotation_gives_every_light_its_own_colour_and_turns():
    cfg = _paired(colour_mode="rotate")
    three = palette_for(cfg, (RED,), 3, 0.0)
    assert len(three) == 3
    # Starts at the picture's colour, the others a third of the wheel on.
    assert three[0] == pytest.approx(RED)
    assert three[1] == pytest.approx(GREEN)
    assert three[2] == pytest.approx(BLUE)
    # A third of the way round later, each light has the next one's colour.
    later = palette_for(cfg, (RED,), 3, ROTATION_SECONDS / 3)
    assert later[0] == pytest.approx(GREEN)
    assert later[2] == pytest.approx(RED)


def test_the_show_turns_the_rotation_over_time(sessions):
    _paired(colour_mode="rotate")
    c = LightController()
    c._channels = (LEFT, RIGHT)
    c._covers["s"] = (RED,)
    now = time.monotonic()
    c._source, c._source_at = Source("x", "s", 0.0), now
    start = (RED, BLUE)
    c._palette = start
    c._frame(now)
    soon = c._palette
    c._palette = start
    c._frame(now + ROTATION_SECONDS / 2)
    # The same step from the same colours heads somewhere else half a turn on.
    assert c._palette != soon


def test_a_new_palette_fades_in(sessions):
    _paired(colour_mode="palette")
    c = LightController()
    c._channels = (LEFT, RIGHT)
    c._palette = (RED,)
    c._covers["s"] = (BLUE, BLUE)
    c._source, c._source_at = Source("x", "s", 0.0), time.monotonic()
    c._frame(time.monotonic())
    assert len(c._palette) == 2
    assert 0 < c._palette[1][2] < 1 and c._palette[1][0] > 0


# ── routes ───────────────────────────────────────────────────────────────


def test_get_unpaired(client):
    body = client.get("/lights").json()
    assert body["paired"] is False
    assert body["areas"] is None


def test_get_paired_lists_the_areas(client, monkeypatch):
    _paired()

    async def list_areas(bridge, pairing):
        assert bridge.bridge_id == "001788fffe000001"
        return [hue.Area(AREA, "Office", (LEFT, RIGHT), False)]

    monkeypatch.setattr(hue, "list_areas", list_areas)
    body = client.get("/lights").json()
    assert body["reachable"] is True
    assert body["areas"] == [{"id": AREA, "name": "Office", "lights": 2}]
    assert body["style"] == "pulse" and body["colour_mode"] == "cover"
    # Never the keys.
    assert "clientkey" not in str(body) and "user" not in body


def test_get_with_the_bridge_away(client, monkeypatch):
    _paired()

    async def list_areas(bridge, pairing):
        raise hue.HueError("timeout")

    monkeypatch.setattr(hue, "list_areas", list_areas)
    body = client.get("/lights").json()
    assert body["paired"] is True
    assert body["reachable"] is False


def test_pair_stores_a_new_pairing_and_drops_old_choices(client, monkeypatch):
    _paired(area_id="old-area", style="wave")
    attempts = []

    async def identify(host):
        return hue.Bridge(host, "001788fffe000002")

    async def pair(bridge, name):
        attempts.append(1)
        if len(attempts) < 2:
            raise hue.LinkButtonNotPressedError()
        return hue.Pairing("u2", "CD" * 16, "app-2")

    async def list_areas(bridge, pairing):
        return []

    monkeypatch.setattr(hue, "identify", identify)
    monkeypatch.setattr(hue, "pair", pair)
    monkeypatch.setattr(hue, "list_areas", list_areas)
    monkeypatch.setattr("routes.lights._PAIR_POLL_SECONDS", 0.01)
    body = client.post("/lights/pair", json={"host": "10.0.0.9"}).json()
    assert body["paired"] is True
    assert body["area_id"] is None
    assert body["style"] == "pulse"
    cfg = lights_config.get()
    assert (cfg.bridge_host, cfg.bridge_id, cfg.app_id) == ("10.0.0.9", "001788fffe000002", "app-2")


def test_pair_times_out_without_the_button(client, monkeypatch):
    async def identify(host):
        return hue.Bridge(host, "id")

    async def pair(bridge, name):
        raise hue.LinkButtonNotPressedError()

    monkeypatch.setattr(hue, "identify", identify)
    monkeypatch.setattr(hue, "pair", pair)
    monkeypatch.setattr("routes.lights.PAIR_WAIT_SECONDS", 0.05)
    monkeypatch.setattr("routes.lights._PAIR_POLL_SECONDS", 0.01)
    reply = client.post("/lights/pair", json={"host": "10.0.0.9"})
    assert reply.status_code == 408
    assert reply.json()["detail"] == "link_button"
    assert not lights_config.get().paired


def test_pair_with_no_bridge_there(client, monkeypatch):
    async def identify(host):
        raise hue.HueError("nothing")

    monkeypatch.setattr(hue, "identify", identify)
    reply = client.post("/lights/pair", json={"host": "10.0.0.9"})
    assert reply.status_code == 404


def test_update_needs_a_pairing(client):
    assert client.put("/lights", json={"enabled": True}).status_code == 409


def test_update_stores_the_choices(client, monkeypatch):
    _paired(enabled=False)

    async def list_areas(bridge, pairing):
        return []

    monkeypatch.setattr(hue, "list_areas", list_areas)
    body = client.put(
        "/lights",
        json={
            "enabled": True,
            "lead_ms": 150,
            "area_id": "x",
            "style": "calm",
            "colour_mode": "fixed",
            "fixed_colour": "#FF8800",
            "brightness": 60,
        },
    ).json()
    assert body["enabled"] is True
    assert body["lead_ms"] == 150
    assert (body["style"], body["colour_mode"]) == ("calm", "fixed")
    assert body["fixed_colour"] == "#ff8800"
    assert body["brightness"] == 60
    cfg = lights_config.get()
    assert (cfg.area_id, cfg.style, cfg.brightness) == ("x", "calm", 60)


def test_rotate_is_a_colour_mode(client, monkeypatch):
    _paired()
    monkeypatch.setattr(hue, "list_areas", _no_areas)
    assert client.put("/lights", json={"colour_mode": "rotate"}).json()["colour_mode"] == "rotate"


def test_an_update_leaves_what_it_does_not_name(client, monkeypatch):
    _paired(style="wave", brightness=40)
    monkeypatch.setattr(hue, "list_areas", _no_areas)
    client.put("/lights", json={"enabled": False})
    cfg = lights_config.get()
    assert (cfg.style, cfg.brightness, cfg.enabled) == ("wave", 40, False)


async def _no_areas(bridge, pairing):
    return []


@pytest.mark.parametrize(
    "change",
    [
        {"lead_ms": 99999},
        {"style": "strobe"},
        {"colour_mode": "rainbow"},
        {"fixed_colour": "red"},
        {"fixed_colour": "#12345"},
        {"brightness": 5},
        {"brightness": 101},
    ],
)
def test_update_rejects_values_out_of_range(client, change):
    _paired()
    assert client.put("/lights", json=change).status_code == 422


def test_forget(client):
    _paired()
    assert client.delete("/lights").json() == {"paired": False}
    assert not lights_config.get().paired


def test_local_reports_reach_the_controller(client, monkeypatch):
    from lights.controller import controller

    seen = []
    monkeypatch.setattr(controller, "report_local", lambda *a: seen.append(a))
    monkeypatch.setattr(controller, "forget_local", lambda *a: seen.append(("forget", *a)))
    assert (
        client.post("/lights/local", json={"song_id": "s", "position": 3.5, "playing": True})
    ).status_code == 204
    assert client.delete("/lights/local").status_code == 204
    assert seen[0][1:] == ("s", 3.5, True)
    assert seen[1][0] == "forget"


def test_picture_reports_reach_the_controller(client, monkeypatch):
    from lights.controller import controller

    seen = []
    monkeypatch.setattr(controller, "set_picture", lambda *a: seen.append(a))
    assert client.put("/lights/picture", json={"song_id": "s", "url": PICTURE}).status_code == 204
    assert client.put("/lights/picture", json={"song_id": "s", "url": None}).status_code == 204
    assert seen == [("s", PICTURE), ("s", None)]


def test_a_picture_report_takes_only_fanart_images(client, monkeypatch):
    from lights.controller import controller

    monkeypatch.setattr(controller, "set_picture", lambda *a: pytest.fail("should not be set"))
    for url in ("https://example.com/a.jpg", "http://assets.fanart.tv/a.jpg", "file:///etc/x"):
        reply = client.put("/lights/picture", json={"song_id": "s", "url": url})
        assert reply.status_code == 422


def test_local_report_rejects_a_negative_position(client):
    reply = client.post("/lights/local", json={"song_id": "s", "position": -1, "playing": True})
    assert reply.status_code == 422


def test_the_routes_need_the_token(monkeypatch):
    from fastapi.testclient import TestClient

    from core import auth
    from main import app

    if not auth.TOKEN:
        pytest.skip("token auth is off in this environment")
    with TestClient(app) as c:
        assert c.get("/lights").status_code == 401


# ── bridge discovery for the app's button ────────────────────────────────


def test_the_first_look_waits_for_the_search_then_answers_from_memory(client, monkeypatch):
    calls = []

    async def discover(timeout=4.0):
        calls.append(1)
        return [hue.Bridge("10.0.0.2", "001788fffe000001")]

    monkeypatch.setattr(hue, "discover", discover)
    assert client.get("/lights").json()["found"] == [{"host": "10.0.0.2", "id": "001788fffe000001"}]
    assert client.get("/lights").json()["found"][0]["host"] == "10.0.0.2"
    assert len(calls) == 1


def test_an_old_list_is_refreshed_in_the_background(client, monkeypatch):
    from routes import lights as lights_routes

    found = [[], [hue.Bridge("10.0.0.3", "id3")]]

    async def discover(timeout=4.0):
        return found.pop(0)

    monkeypatch.setattr(hue, "discover", discover)
    assert client.get("/lights").json()["found"] == []
    lights_routes._found_at -= lights_routes.DISCOVERY_MAX_AGE_SECONDS + 1
    # Answers with what it had, and looks again meanwhile.
    assert client.get("/lights").json()["found"] == []
    for _ in range(50):
        if client.get("/lights").json()["found"]:
            break
        time.sleep(0.02)
    assert client.get("/lights").json()["found"][0]["host"] == "10.0.0.3"


def test_a_paired_installation_does_not_search(client, monkeypatch):
    _paired()

    async def discover(timeout=4.0):
        raise AssertionError("searched")

    async def list_areas(bridge, pairing):
        return []

    monkeypatch.setattr(hue, "discover", discover)
    monkeypatch.setattr(hue, "list_areas", list_areas)
    assert client.get("/lights").json()["found"] == []


def test_a_failed_search_counts_as_none_found(client, monkeypatch):
    async def discover(timeout=4.0):
        raise OSError("no multicast here")

    monkeypatch.setattr(hue, "discover", discover)
    assert client.get("/lights").json()["found"] == []
