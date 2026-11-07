"""Tests for a speaker's equalizer: core/equalizer.py, and where it reaches
the cast path - /play, /equalizers, the format decision, each device's own
stream, a mix listener's encoder and a device joining."""

import asyncio
import math
import shutil
import subprocess
from unittest.mock import AsyncMock, patch

import numpy as np
import pytest

from core import equalizer
from core.equalizer import (
    LIVE_TAPS,
    MAX_BANDS,
    MAX_GAIN_DB,
    LiveEqualizer,
    any_active,
    audio_filter,
    curve_for_connection,
    headroom_db,
    live_taps,
    sanitize,
)
from core.ffmpeg import FFMPEG_BIN
from core.streamer import FALLBACK_FORMAT, OutputFormat, SourceInfo, resolve_output_format
from delivery import AirPlayDelivery, ChromecastDelivery, DeliveryManager, SonosDelivery
from media import Track
from routes import join, mix_cast


def _band(frequency: float, gain: float, q: float = 1.41) -> dict:
    return {"frequency": frequency, "gain": gain, "q": q}


BASS = [_band(62, 6)]


# ── sanitize ─────────────────────────────────────────────────────────────────


def test_sanitize_keeps_a_well_formed_curve():
    assert sanitize([_band(62, 6), _band(8000, -3)]) == [_band(62, 6), _band(8000, -3)]


def test_sanitize_drops_flat_bands():
    """A flat band is no filter at all - ffmpeg should not run a pass that
    changes nothing, and a curve of only flat bands is no equalizer."""
    assert sanitize([_band(62, 0), _band(125, 0.001)]) == []


def test_sanitize_clamps_the_gain():
    assert sanitize([_band(62, 40), _band(125, -40)]) == [
        _band(62, MAX_GAIN_DB),
        _band(125, -MAX_GAIN_DB),
    ]


@pytest.mark.parametrize(
    "band",
    [
        _band(5, 3),
        _band(30000, 3),
        _band(float("nan"), 3),
        _band(62, float("inf")),
        {"frequency": 62, "gain": 3},
        {"frequency": "low", "gain": 3, "q": 1},
        "62:3",
    ],
    ids=["below 20Hz", "above 20kHz", "nan", "inf", "no q", "not a number", "not a dict"],
)
def test_sanitize_drops_what_ffmpeg_cannot_take(band):
    assert sanitize([band, _band(62, 6)]) == [_band(62, 6)]


def test_sanitize_caps_the_number_of_bands():
    assert len(sanitize([_band(100 + i, 1) for i in range(MAX_BANDS + 5)])) == MAX_BANDS


def test_sanitize_reads_anything_else_as_no_curve():
    assert sanitize(None) == []
    assert sanitize({"frequency": 62}) == []


# ── headroom ─────────────────────────────────────────────────────────────────


def test_no_headroom_without_a_curve():
    assert headroom_db([]) == 0.0


def test_a_curve_that_only_cuts_needs_no_headroom():
    assert headroom_db([_band(62, -6), _band(8000, -3)]) == 0.0


def test_a_single_boost_needs_its_own_gain():
    """A peaking band reaches exactly its gain at its centre frequency."""
    assert headroom_db([_band(1000, 6)]) == pytest.approx(6.0, abs=0.05)


def test_neighbouring_boosts_add_up_between_them():
    """The reason headroom is worked out from the response rather than
    the highest band: two octave-apart boosts overlap."""
    assert headroom_db([_band(1000, 6), _band(2000, 6)]) > 6.5


# ── audio_filter ─────────────────────────────────────────────────────────────


def test_no_filter_when_nothing_changes():
    assert audio_filter(1.0, []) is None


def test_replay_gain_alone_is_the_volume_filter_it_always_was():
    assert audio_filter(0.5, []) == "volume=0.5"


def test_a_cut_only_curve_has_no_volume_filter():
    assert audio_filter(1.0, [_band(8000, -3)]) == "equalizer=f=8000:t=q:w=1.41:g=-3"


def test_replay_gain_and_headroom_share_one_volume_filter():
    chain = audio_filter(0.5, [_band(1000, 6)])
    volume, band = chain.split(",")
    level = float(volume.removeprefix("volume="))
    assert level == pytest.approx(0.5 * 10 ** (-6 / 20), rel=0.01)
    assert band == "equalizer=f=1000:t=q:w=1.41:g=6"


# ── which curve belongs to which device ──────────────────────────────────────


def _manager(*deliveries):
    return DeliveryManager.from_deliveries(list(deliveries))


def test_a_lone_target_gets_its_curve_whoever_fetches():
    curves = {"sonos:Kitchen": BASS}
    assert curve_for_connection(curves, SonosDelivery("Kitchen"), None, None) == BASS


def test_a_device_without_a_curve_gets_none():
    curves = {"sonos:Kitchen": BASS}
    assert curve_for_connection(curves, SonosDelivery("Living room"), "10.0.0.9", None) == []


def test_several_targets_are_told_apart_by_address():
    kitchen, tv = SonosDelivery("Kitchen"), ChromecastDelivery("TV")
    kitchen.stream_peer, tv.stream_peer = "10.0.0.5", "10.0.0.6"
    curves = {"chromecast:TV": BASS}
    assert curve_for_connection(curves, _manager(kitchen, tv), "10.0.0.6", None) == BASS
    assert curve_for_connection(curves, _manager(kitchen, tv), "10.0.0.5", None) == []


def test_airplay_is_told_apart_by_the_name_on_its_url():
    """connect fetches for every AirPlay target itself, so the address is
    always its own - see delivery/base.py's STREAM_SENDER_PARAM."""
    curves = {"airplay:HomePod": BASS}
    delivery = _manager(AirPlayDelivery("HomePod"), AirPlayDelivery("Office"))
    assert curve_for_connection(curves, delivery, "127.0.0.1", "homepod") == BASS
    assert curve_for_connection(curves, delivery, "127.0.0.1", "Office") == []


def test_a_connection_nobody_recognises_plays_flat():
    kitchen, tv = SonosDelivery("Kitchen"), ChromecastDelivery("TV")
    curves = {"sonos:Kitchen": BASS, "chromecast:TV": BASS}
    assert curve_for_connection(curves, _manager(kitchen, tv), "10.0.0.99", None) == []


def test_any_active_looks_at_every_target():
    curves = {"chromecast:TV": BASS}
    assert any_active(curves, _manager(SonosDelivery("Kitchen"), ChromecastDelivery("TV")))
    assert not any_active(curves, SonosDelivery("Kitchen"))
    assert not any_active(curves, None)


# ── the format decision ──────────────────────────────────────────────────────


def _info(codec: str) -> SourceInfo:
    return SourceInfo(
        codec=codec, sample_rate=44100, bit_depth=16, bitrate_kbps=None, channels=2, duration=180.0
    )


def _resolve(codec: str, **kwargs) -> OutputFormat:
    with patch("core.streamer._probe_source", AsyncMock(return_value=_info(codec))):
        return asyncio.run(resolve_output_format("http://nav/stream", **kwargs))


@pytest.mark.parametrize("codec", ["mp3", "aac", "vorbis"])
def test_an_equalizer_rules_out_the_copy_tier(codec):
    """ffmpeg cannot filter and stream-copy at once - same as ReplayGain."""
    fmt = _resolve(codec, equalized=True)
    assert "copy" not in fmt.ffmpeg_args
    assert fmt.transcode_reason == "equalizer"


def test_an_equalized_flac_stays_lossless_where_the_device_plays_flac():
    fmt = _resolve("flac", equalized=True, device_codecs=frozenset({"mp3", "flac"}))
    assert fmt.ffmpeg_args[:2] == ["-acodec", "flac"]
    assert fmt.transcode_reason == "equalizer"


def test_an_equalized_flac_falls_back_where_the_device_does_not():
    fmt = _resolve("flac", equalized=True, device_codecs=frozenset({"mp3", "aac"}))
    assert fmt.ffmpeg_args == FALLBACK_FORMAT.ffmpeg_args


def test_without_an_equalizer_the_copy_tier_is_untouched():
    assert _resolve("mp3", equalized=False).ffmpeg_args == ["-acodec", "copy", "-f", "mp3"]


def test_an_equalizer_leaves_the_lossless_reencode_tier_alone():
    fmt = _resolve("alac", equalized=True)
    assert fmt.ffmpeg_args[:2] == ["-acodec", "flac"]
    assert fmt.transcode_reason == "lossless_container"


# ── /play and /equalizers ────────────────────────────────────────────────────

_TRACK = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="c")


def _play(client, default_session, **body):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    with (
        patch.object(default_session.media, "get_track", return_value=_TRACK),
        patch(
            "routes.playback.resolve_output_format", AsyncMock(return_value=FALLBACK_FORMAT)
        ) as resolve_mock,
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
    ):
        client.post(
            "/play",
            json={"song_ids": ["1"], "target_name": "TV", "target_type": "chromecast", **body},
        )
    return resolve_mock


def test_play_remembers_the_curves_and_judges_the_format_by_them(client, default_session):
    resolve = _play(
        client, default_session, equalizers={"chromecast:TV": BASS, "sonos:Kitchen": [_band(62, 0)]}
    )
    assert default_session.state.equalizers == {"chromecast:TV": BASS}
    assert resolve.call_args.kwargs["equalized"] is True


def test_play_judges_by_the_target_it_dispatches_to(client, default_session):
    resolve = _play(client, default_session, equalizers={"sonos:Kitchen": BASS})
    assert resolve.call_args.kwargs["equalized"] is False


def test_play_without_curves_keeps_the_sessions_own(client, default_session):
    """An older client sends none; what this session was told stays."""
    default_session.state.equalizers = {"chromecast:TV": BASS}
    resolve = _play(client, default_session)
    assert default_session.state.equalizers == {"chromecast:TV": BASS}
    assert resolve.call_args.kwargs["equalized"] is True


def test_the_equalizers_endpoint_replaces_the_curves(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    default_session.state.equalizers = {"sonos:Kitchen": BASS}
    r = client.post(
        "/equalizers", json={"equalizers": {"chromecast:TV": [_band(8000, -3), "junk"]}}
    )
    assert r.json() == {"status": "ok"}
    assert default_session.state.equalizers == {"chromecast:TV": [_band(8000, -3)]}


# ── each device's own stream ─────────────────────────────────────────────────


async def _one_chunk(*_args, **_kwargs):
    yield b"audio"


def _cast_two(default_session):
    st = default_session.state
    st.current_track = _TRACK
    st.is_streaming = True
    st.active_delivery = _manager(AirPlayDelivery("HomePod"), AirPlayDelivery("Office"))
    st.equalizers = {"airplay:HomePod": BASS}


def test_a_device_is_streamed_with_its_own_curve(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    with patch("routes.stream.stream_tracks", side_effect=_one_chunk) as stream:
        # Set up again for the second: the first one's song has ended.
        for sender in ("HomePod", "Office"):
            _cast_two(default_session)
            client.get(f"/stream/{default_session.session_id}?sender={sender}")
    assert stream.call_args_list[0].kwargs["equalizer"] == BASS
    assert stream.call_args_list[1].kwargs["equalizer"] == []


def test_a_mix_listener_is_handed_its_curve_rather_than_an_encoder_filter():
    """The mix's encoder lives as long as the mix: a filter in it would be
    fixed for all of that, so the curve goes in as something to ask."""
    connected = []

    class _Connection:
        async def chunks(self):
            yield b"mixed"

        def close(self):
            pass

    class _Mix:
        async def connect(self, start_time, args, curve=None):
            connected.append((args, curve))
            return _Connection()

    def curve():
        return BASS

    async def _drain():
        fmt = OutputFormat(ffmpeg_args=["-acodec", "aac", "-f", "adts"])
        return [c async for c in mix_cast.mix_audio(_Mix(), 0.0, fmt, curve)]

    assert asyncio.run(_drain()) == [b"mixed"]
    assert connected == [(["-acodec", "aac", "-f", "adts"], curve)]


# ── a device joining ─────────────────────────────────────────────────────────


def test_a_joiner_with_a_curve_changes_what_has_to_be_encoded():
    """A second speaker with an equalizer turns a copy into a re-encode -
    the join must not skip the re-probe on the grounds that nothing about
    the devices' limits changed."""
    one = ChromecastDelivery("TV")
    both = _manager(one, ChromecastDelivery("Kitchen"))
    curves = {"chromecast:Kitchen": BASS}
    assert join._encode_capabilities(one, curves) != join._encode_capabilities(both, curves)
    assert join._encode_capabilities(one, {}) == join._encode_capabilities(both, {})


# ── against a real ffmpeg ────────────────────────────────────────────────────

_RATE = 44100


def _level_through(chain: str, frequency: float) -> float:
    """dB a sine at `frequency` comes out of `chain` at, against going in."""
    t = np.arange(_RATE * 2) / _RATE
    tone = (0.25 * np.sin(2 * np.pi * frequency * t) * 32767).astype("<i2")
    stereo = np.repeat(tone, 2).tobytes()
    out = subprocess.run(
        [
            *(shutil.which(FFMPEG_BIN) or FFMPEG_BIN,),
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            str(_RATE),
            "-ac",
            "2",
            "-i",
            "pipe:0",
            "-af",
            chain,
            "-f",
            "s16le",
            "pipe:1",
        ],
        input=stereo,
        capture_output=True,
        check=True,
    ).stdout

    # The middle second: the filters' own settling is long over by then.
    def rms(pcm: np.ndarray) -> float:
        middle = pcm[len(pcm) // 4 : 3 * len(pcm) // 4].astype(np.float64)
        return math.sqrt(float(np.mean(middle**2)))

    received = np.frombuffer(out, dtype="<i2")[::2]
    return 20 * math.log10(rms(received) / rms(tone))


@pytest.mark.skipif(shutil.which(FFMPEG_BIN) is None, reason="needs a real ffmpeg")
@pytest.mark.parametrize("frequency", [1000, 1414, 4000])
def test_ffmpeg_plays_the_curve_this_module_works_out(frequency):
    """The headroom here and the curve the renderer draws and plays both
    come from the RBJ formula in this module (and its twin in
    services/equalizer.ts); ffmpeg's equalizer has to be the same filter,
    or a curve sounds different on a speaker than it looks."""
    bands = [_band(1000, 6), _band(2000, -4)]
    expected = float(
        equalizer._peaking_response_db(bands[0], np.array([frequency]))[0]
        + equalizer._peaking_response_db(bands[1], np.array([frequency]))[0]
    ) - headroom_db(bands)
    assert _level_through(audio_filter(1.0, bands), frequency) == pytest.approx(expected, abs=0.3)


@pytest.mark.skipif(shutil.which(FFMPEG_BIN) is None, reason="needs a real ffmpeg")
def test_a_boosted_curve_never_comes_out_louder_than_it_went_in():
    bands = [_band(1000, 6), _band(2000, 6)]
    for frequency in (1000, 1414, 2000):
        assert _level_through(audio_filter(1.0, bands), frequency) <= 0.1


# ── live, in the mix ─────────────────────────────────────────────────────────

SMALL_SPEAKER = [
    _band(f, g)
    for f, g in zip(
        [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
        [-6, -2, 3, 3, 1, 0, 0, 1, 2, 1],
        strict=True,
    )
    if g
]


def _tone(frequency: float, seconds: float = 2.0, amplitude: float = 0.25) -> bytes:
    t = np.arange(int(_RATE * seconds)) / _RATE
    tone = (amplitude * np.sin(2 * np.pi * frequency * t) * 32767).astype("<i2")
    return np.repeat(tone, 2).tobytes()


def _live(pcm: bytes, curves, block: int = _RATE // 10) -> bytes:
    """`pcm` through one LiveEqualizer in mix-sized blocks; `curves(i)` is
    the curve for block i."""
    eq = LiveEqualizer()
    step = block * 4
    return b"".join(
        eq.process(pcm[i : i + step], curves(i // step)) for i in range(0, len(pcm), step)
    )


def _rms_db(pcm: bytes, start: float = 0.25, end: float = 0.75) -> float:
    left = np.frombuffer(pcm, dtype="<i2")[::2].astype(np.float64)
    middle = left[int(len(left) * start) : int(len(left) * end)]
    return 20 * math.log10(math.sqrt(float(np.mean(middle**2))))


@pytest.mark.parametrize(
    "bands",
    [[_band(31, 12)], [_band(31, -12)], [_band(16000, 12)], SMALL_SPEAKER, [_band(1000, 6)]],
)
def test_the_live_filter_is_the_curve_the_biquads_make(bands):
    """Within 0.5 dB of the RBJ response, headroom included, across the
    audible range - the ffmpeg path and the renderer hear the biquads."""
    freqs = np.geomspace(20, 20000, 400)
    expected = sum(equalizer._peaking_response_db(b, freqs, _RATE) for b in bands) - headroom_db(
        bands
    )
    response = np.fft.rfft(live_taps(equalizer._bands_key(bands)), 1 << 16)
    grid = np.fft.rfftfreq(1 << 16, 1 / _RATE)
    actual = np.interp(freqs, grid, 20 * np.log10(np.abs(response)))
    assert np.max(np.abs(actual - expected)) < 0.5


def test_the_live_filter_is_short_enough_to_follow_a_slider():
    assert len(live_taps(equalizer._bands_key(BASS))) == LIVE_TAPS


def test_without_a_curve_the_mix_goes_through_untouched():
    pcm = _tone(440, 0.5)
    assert _live(pcm, lambda _i: []) == pcm


@pytest.mark.skipif(shutil.which(FFMPEG_BIN) is None, reason="needs a real ffmpeg")
@pytest.mark.parametrize("frequency", [40, 125, 1000, 8000])
def test_the_mix_sounds_like_a_single_songs_stream(frequency):
    """A curve sounds the same on a speaker whether transitions are on (live
    filter) or off (ffmpeg's equalizer)."""
    pcm = _tone(frequency)
    live = _rms_db(_live(pcm, lambda _i: SMALL_SPEAKER)) - _rms_db(pcm)
    assert live == pytest.approx(
        _level_through(audio_filter(1.0, SMALL_SPEAKER), frequency), abs=0.5
    )


def test_a_curve_changed_mid_mix_is_heard_from_then_on():
    pcm = _tone(62, 4.0)
    out = _live(pcm, lambda i: [] if i < 20 else BASS)
    before = _rms_db(out, 0.1, 0.45) - _rms_db(pcm, 0.1, 0.45)
    after = _rms_db(out, 0.6, 0.95) - _rms_db(pcm, 0.6, 0.95)
    assert before == pytest.approx(0.0, abs=0.05)
    expected = float(equalizer._peaking_response_db(BASS[0], np.array([62.0]), _RATE)[0])
    assert after == pytest.approx(expected - headroom_db(BASS), abs=0.3)


@pytest.mark.parametrize(
    ("first", "then"),
    [([], [_band(1000, 12)]), ([_band(1000, 12)], [_band(1000, -12)]), ([_band(1000, 12)], [])],
)
def test_a_changed_curve_does_not_click(first, then):
    """The step between two samples never jumps further than the tone's own
    steepest one could, plus dither - a hard switch between two filters
    would."""
    # Not a round 1000 Hz: blocks are a tenth of a second, so every block
    # would start on a zero crossing, where even a hard switch is silent.
    frequency = 1000.5
    pcm = _tone(frequency, 1.0, amplitude=0.5)
    out = np.frombuffer(_live(pcm, lambda i: first if i < 5 else then), dtype="<i2")[::2]
    steepest = 0.5 * 32767 * 2 * math.pi * frequency / _RATE
    assert np.max(np.abs(np.diff(out.astype(np.int64)))) < steepest * 1.05 + 4


def test_switching_the_curve_off_returns_the_mix_untouched():
    block = _RATE // 10
    pcm = _tone(440, 1.0)
    out = _live(pcm, lambda i: BASS if i < 3 else [], block)
    # The block the change lands in is the crossfade; everything after is
    # the input again, byte for byte.
    assert out[4 * block * 4 :] == pcm[4 * block * 4 :]
