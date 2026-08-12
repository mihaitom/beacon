"""routes/debug.py — Diagnostic-only endpoints, not part of the app's real
feature set.

GET /debug/test-tone.wav + POST /debug/play-test-tone: swaps whatever's
currently playing/casting for a synthesized test signal (silence with a
short, precisely-timed beep every _INTERVAL_S seconds). Built for
eyeballing exactly how far off (and in which direction) the fullscreen
visualizer's 'cast' mode timing is against an audio cue with an
unambiguous, known-in-advance onset — much easier to judge by ear/eye than
trying to eyeball it against a real track's fuzzy transients.

Goes through the exact same /stream -> ffmpeg -> AudioAnalyzer pipeline as
a real track (see routes/stream.py's TEST_TONE_TRACK_ID special case) —
only the source audio differs, not any of the analysis/pacing machinery
being diagnosed.
"""

import asyncio
import io
import logging
import math
import struct
import wave

from fastapi import APIRouter, Depends, Response

from core.session import SessionState, build_status_dict, require_authenticated_session
from core.state import stream_url
from media.base import Track

from .playback import _apply_position_offset

logger = logging.getLogger("connect.debug")
router = APIRouter(prefix="/debug")

TEST_TONE_TRACK_ID = "__test_tone__"

_SAMPLE_RATE = 44100
_DURATION_S = 600  # long enough to not run out mid-session
_INTERVAL_S = 10
_BEEP_S = 0.3
_FREQ_HZ = 880.0


def _generate_test_tone_wav() -> bytes:
    beep_samples = int(_BEEP_S * _SAMPLE_RATE)
    interval_samples = _INTERVAL_S * _SAMPLE_RATE
    silence_samples = interval_samples - beep_samples

    # Short linear fade in/out so the beep's edges don't click — makes it
    # easier to judge the beep's actual audible *center*, not a transient.
    ramp = min(200, beep_samples // 4) or 1
    beep = bytearray(beep_samples * 2)
    for i in range(beep_samples):
        envelope = min(1.0, i / ramp, (beep_samples - i) / ramp)
        sample = int(envelope * 32767 * math.sin(2 * math.pi * _FREQ_HZ * i / _SAMPLE_RATE))
        struct.pack_into("<h", beep, i * 2, sample)
    silence = bytes(silence_samples * 2)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(_SAMPLE_RATE)
        for _ in range(_DURATION_S // _INTERVAL_S):
            wav.writeframes(bytes(beep))
            wav.writeframes(silence)
    return buf.getvalue()


# Generated once, on first request — deterministic content, no reason to
# regenerate it (~800KB, trivial to hold in memory for the process lifetime).
_cached_wav: bytes | None = None


@router.get("/test-tone.wav")
async def test_tone_wav() -> Response:
    global _cached_wav
    if _cached_wav is None:
        _cached_wav = _generate_test_tone_wav()
    return Response(content=_cached_wav, media_type="audio/wav")


@router.post("/play-test-tone")
async def play_test_tone(session: SessionState = Depends(require_authenticated_session)):
    """Swaps the current session's *already-active* delivery target onto
    the test tone — reuses whatever device is already connected/claimed
    rather than resolving/claiming a new one, so start by playing
    something normal first (join a device, hit play), then call this."""
    st = session.state
    target = st.active_delivery
    if not target:
        return {
            "error": "No active delivery — connect a device and start playing something first"
        }

    st.current_track = Track(
        id=TEST_TONE_TRACK_ID,
        title="Test Tone",
        artist="Debug",
        duration=_DURATION_S,
    )
    st.current_track_gain = 1.0
    st.is_streaming = True
    st.radio_info = None
    st.clock.start(0.0)
    st.track_ended = False

    url = stream_url(session.session_id)
    try:
        await target.play(url, "Test Tone", "Debug", None, float(_DURATION_S), "")
    except Exception as e:
        logger.error(f"[debug] play-test-tone delivery error: {e}", exc_info=True)
        return {"error": str(e)}

    asyncio.create_task(_apply_position_offset(session, target, st.clock.play_generation))
    logger.info(f"[debug] ▶ test tone — beep every {_INTERVAL_S}s")
    await session.event_bus.broadcast(build_status_dict(session))
    return {"status": "playing", "interval_seconds": _INTERVAL_S}
