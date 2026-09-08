"""Tests that build/ffmpeg/required-components still lists everything this
backend can put on an ffmpeg command line.

The bundled ffmpeg is built from a hand-written list of components
(build/ffmpeg/configure-flags), and ffmpeg's configure ignores a name it
doesn't recognise as long as something else in the same comma list matched.
So a format added here and forgotten there produces a build that succeeds
and a track that won't play — which is how a missing `volume` filter, a
missing `aac` encoder and a missing `pcm_s32be` decoder each reached a
release.

scripts/verify-ffmpeg.sh closes that from the build's side: it refuses to
finish a binary that is missing anything on the list. These tests close it
from the code's side, so the list cannot fall behind the code either.
Together: add a format to the app and this suite fails until the contract
names it, then the build fails until the recipe can produce it.
"""

import re
from itertools import pairwise
from pathlib import Path

import pytest

from core import audio_analysis, radio_relay, waveform
from core.streamer import (
    _COPY_MUXER_FOR_CODEC,
    _FALLBACK_ARGS,
    _LOSSLESS_REENCODE_CODECS,
    _LOSSY_ENCODERS,
    lossless_encode_args,
    lossy_encode_args,
)
from routes import debug

_REQUIRED_COMPONENTS = (
    Path(__file__).resolve().parents[2] / "build" / "ffmpeg" / "required-components"
)


def _contract() -> dict[str, set[str]]:
    """The required-components file as {kind: {name, ...}}."""
    assert _REQUIRED_COMPONENTS.is_file(), f"{_REQUIRED_COMPONENTS} is missing"
    kinds: dict[str, set[str]] = {}
    for line in _REQUIRED_COMPONENTS.read_text().splitlines():
        line = line.split("#")[0].strip()
        if not line:
            continue
        kind, name = line.split()
        kinds.setdefault(kind, set()).add(name)
    return kinds


def _components_named_in(args: list[str]) -> tuple[set[str], set[str], set[str]]:
    """(encoders, muxers, filters) an ffmpeg argument list names.

    Reads the real argument lists rather than a second copy of them, so a
    tier whose command changes is re-read rather than re-described."""
    encoders, muxers, filters = set(), set(), set()
    for flag, value in pairwise(args):
        if flag in ("-acodec", "-c:a") and value != "copy":
            encoders.add(value)
        elif flag == "-f":
            muxers.add(value)
        elif flag == "-af":
            # "volume=0.7" and any future "name=value,name=value" chain.
            filters.update(re.findall(r"([a-z_][a-z_0-9]*)=", value))
    return encoders, muxers, filters


def _every_command() -> list[list[str]]:
    """Every ffmpeg argument list this backend builds for an output.

    The radio relay and the debug test station are in here because they
    build their own command lines rather than going through
    lossy_encode_args() — which is exactly where this would otherwise stop
    noticing. Everything else routes through the tiers above:
    routes/local_stream.py calls lossy_encode_args()/lossless_encode_args()
    for its own output."""
    commands = [
        list(_FALLBACK_ARGS),
        list(lossless_encode_args()[0]),
        list(waveform._DECODE_CMD),
        # gain != 1.0 so the ReplayGain filter is actually in there.
        list(audio_analysis._decode_cmd("http://nav/stream", 12.0, 0.7)),
        # The relay's own four: pass a station through untouched as mp3 or
        # aac, or re-encode it to either.
        list(radio_relay._COPY_ARGS),
        list(radio_relay._AAC_COPY_ARGS),
        list(radio_relay._encode_args(192)),
        list(radio_relay._encode_args(192, aac=True)),
        list(debug._station_cmd("http://station/stream")),
    ]
    commands += [list(lossy_encode_args(fmt, 192)[0]) for fmt in _LOSSY_ENCODERS]
    commands += [["-acodec", "copy", "-f", muxer] for muxer in _COPY_MUXER_FOR_CODEC.values()]
    commands += [
        list(radio_relay._device_output_args(content_type, 320, limit, preferred)[0])
        for content_type in ("audio/mpeg", "audio/aac", "audio/ogg")
        for limit in (None, 128)
        for preferred in (None, "mp3", "aac")
    ]
    return commands


def test_every_encoder_the_backend_names_is_in_the_contract():
    required = _contract()["encoder"]
    named = set()
    for command in _every_command():
        named |= _components_named_in(command)[0]
    assert named, "no encoders found — the argument lists moved"
    assert named <= required, f"not in required-components: {sorted(named - required)}"


def test_every_muxer_the_backend_names_is_in_the_contract():
    required = _contract()["muxer"]
    named = set()
    for command in _every_command():
        named |= _components_named_in(command)[1]
    assert named, "no muxers found — the argument lists moved"
    assert named <= required, f"not in required-components: {sorted(named - required)}"


def test_every_filter_the_backend_names_is_in_the_contract():
    required = _contract()["filter"]
    named = set()
    for command in _every_command():
        named |= _components_named_in(command)[2]
    assert "volume" in named, "the ReplayGain filter is no longer reachable from these commands"
    assert named <= required, f"not in required-components: {sorted(named - required)}"


@pytest.mark.parametrize(
    "codec", sorted(_LOSSLESS_REENCODE_CODECS | set(_COPY_MUXER_FOR_CODEC)), ids=str
)
def test_every_source_codec_a_tier_recognises_has_a_decoder(codec):
    """A codec resolve_output_format() has a tier for is a codec ffmpeg has
    to be able to open — otherwise the tier is chosen and then fails."""
    assert codec in _contract()["decoder"]


# Decoders that deliberately get no tier of their own in
# resolve_output_format(): everything lossy, which is re-encoded, or copied
# where _COPY_MUXER_FOR_CODEC says so. Opus is here because it is decodable
# and deliberately never copied — see REASON_CODEC_NOT_CASTABLE.
_DECODERS_WITH_NO_TIER = {
    "mp3float",
    "mp2",
    "mp2float",
    "opus",
    "aac_latm",
    "wmav1",
    "wmav2",
    "wmapro",
    "mpc7",
    "mpc8",
}


def test_every_decoder_in_the_contract_is_accounted_for():
    """The other direction: a codec the bundled ffmpeg learns to decode has
    to land in a tier or be named as deliberately tier-less.

    This is the check the code was missing. pcm_s24le was in the lossless
    tier and pcm_s24be, pcm_s32le and pcm_f32le were not, for no reason
    anyone had decided — a 32-bit WAV cast as mp3 while a 24-bit one cast as
    FLAC, and nothing said so."""
    handled = _LOSSLESS_REENCODE_CODECS | set(_COPY_MUXER_FOR_CODEC) | _DECODERS_WITH_NO_TIER
    unaccounted = _contract()["decoder"] - handled
    assert not unaccounted, (
        f"decodable but no tier recognises them: {sorted(unaccounted)} — "
        "add them to _LOSSLESS_REENCODE_CODECS/_COPY_MUXER_FOR_CODEC in "
        "core/streamer.py, or to _DECODERS_WITH_NO_TIER here with the reason"
    )
