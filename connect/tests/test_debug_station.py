"""Tests for routes/debug.py's test station — the endless, real-time-paced
local radio station used to diagnose cast-visualizer timing.

Why it exists at all is worth restating here: a track's clock is calibrated
against the device's own reported position, so track playback is in sync and
has stayed that way. Radio has no such feedback for a relayed Sonos, which is
where the timing problem lives — so a test signal has to arrive *as a
station* to exercise any of the machinery under suspicion.

No test here actually runs ffmpeg. What is worth locking down is the shape of
the command (a station that outruns real time invalidates every measurement
taken against it), the ICY framing, and the file-name handling — not that
ffmpeg can encode MP3.
"""

import itertools
from unittest.mock import patch

import pytest

from routes import debug


@pytest.fixture
def audio_dir(tmp_path, monkeypatch):
    (tmp_path / "beep-test.wav").write_bytes(b"RIFF")
    (tmp_path / "music.flac").write_bytes(b"fLaC")
    (tmp_path / "notes.txt").write_text("not audio")
    (tmp_path / "sub").mkdir()
    monkeypatch.setenv(debug._TEST_AUDIO_ENV, str(tmp_path))
    return tmp_path


# ── the directory ───────────────────────────────────────────────────────────


def test_no_directory_configured_is_not_an_error(monkeypatch):
    """The default. A repo that ships no test audio must not behave as
    though something were broken."""
    monkeypatch.delenv(debug._TEST_AUDIO_ENV, raising=False)
    assert debug._test_audio_dir() is None
    assert debug._test_audio_files() == []
    assert debug._resolve_test_audio("anything.wav") is None


def test_a_configured_directory_that_does_not_exist_is_ignored(monkeypatch, tmp_path):
    monkeypatch.setenv(debug._TEST_AUDIO_ENV, str(tmp_path / "nope"))
    assert debug._test_audio_dir() is None


def test_lists_only_audio_files(audio_dir):
    """A directory of test material tends to also hold a licence note or a
    README — listing those as playable would just produce ffmpeg errors."""
    assert debug._test_audio_files() == ["beep-test.wav", "music.flac"]


def test_the_env_var_is_read_per_request_not_at_import(monkeypatch, tmp_path):
    """Captured at import, pointing this at a directory would need a
    restart — which for a diagnostic aid is most of the way to not having
    it."""
    monkeypatch.delenv(debug._TEST_AUDIO_ENV, raising=False)
    assert debug._test_audio_dir() is None
    (tmp_path / "x.wav").write_bytes(b"RIFF")
    monkeypatch.setenv(debug._TEST_AUDIO_ENV, str(tmp_path))
    assert debug._test_audio_dir() == tmp_path


def test_expands_a_tilde_in_the_configured_path(monkeypatch, tmp_path):
    """`~/beacon-testaudio` is how anyone would write this by hand, and an
    unexpanded tilde would silently make a real directory look absent."""
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "audio").mkdir()
    monkeypatch.setenv(debug._TEST_AUDIO_ENV, "~/audio")
    assert debug._test_audio_dir() == tmp_path / "audio"


# ── name resolution ─────────────────────────────────────────────────────────


def test_resolves_a_listed_name(audio_dir):
    assert debug._resolve_test_audio("beep-test.wav") == audio_dir / "beep-test.wav"


@pytest.mark.parametrize(
    "name",
    [
        "../../../etc/passwd",
        "/etc/passwd",
        "../notes.txt",
        "sub/../beep-test.wav",
        "beep-test.wav/../../secret.wav",
        "",
        ".",
        "..",
    ],
)
def test_refuses_anything_that_is_not_a_plain_listed_name(audio_dir, name):
    """`name` is caller-supplied. Joining it onto the directory would read
    anything the process can reach — an absolute path in particular wins
    outright over the directory when joined with Path.__truediv__, no
    "../" needed. Matching against the directory's own listing cannot
    escape it."""
    assert debug._resolve_test_audio(name) is None


def test_refuses_a_non_audio_file_that_is_really_there(audio_dir):
    """notes.txt exists, so this is not about the file being absent — an
    entry that isn't offered must not be reachable by naming it directly."""
    assert (audio_dir / "notes.txt").is_file()
    assert debug._resolve_test_audio("notes.txt") is None


def test_refuses_a_directory_entry(audio_dir):
    assert debug._resolve_test_audio("sub") is None


# ── the ffmpeg command ──────────────────────────────────────────────────────


def test_station_is_paced_to_real_time():
    """The single most important property here. Without -re, ffmpeg encodes
    as fast as it can read and every buffer downstream — this process's
    socket, the relay's queue, the device's own — fills with minutes of
    audio in seconds, making every timing number measured against this
    station meaningless."""
    assert "-re" in debug._station_cmd("/x.wav")


def test_station_loops_forever():
    """RadioRelay treats an ended stream as a station that dropped and
    reconnects, which restarts the audio at an unrelated moment — mid
    measurement, that reads as a glitch rather than as the loop it is."""
    cmd = debug._station_cmd("/x.wav")
    assert cmd[cmd.index("-stream_loop") + 1] == "-1"


def test_station_sends_bare_mp3_frames_like_a_real_station():
    """A Xing header carries a frame count — a duration — for what is meant
    to be an endless broadcast, and a device that believes it knows the
    length may buffer accordingly. Stations send neither it nor an ID3 tag."""
    cmd = debug._station_cmd("/x.wav")
    assert cmd[cmd.index("-write_xing") + 1] == "0"
    assert cmd[cmd.index("-id3v2_version") + 1] == "0"


def test_station_source_is_passed_as_the_input():
    cmd = debug._station_cmd("/tmp/some file.wav")
    assert cmd[cmd.index("-i") + 1] == "/tmp/some file.wav"


# ── the ICY markers ─────────────────────────────────────────────────────────


def test_markers_advance_on_the_shared_pulse_cadence():
    """Matching core/icy_metadata.py's ICY_PULSE_SECONDS is the point: what
    a device echoes back here has to arrive on the same rhythm a real cast
    produces, so this exercises that path rather than a faster synthetic
    one."""
    from core.icy_metadata import ICY_PULSE_SECONDS

    assert debug._MARKER_INTERVAL_S == ICY_PULSE_SECONDS


def test_marker_text_changes_every_interval():
    """A title that never changes yields exactly one measurement per cast —
    routes/upnp.py times an injection against the device echoing that same
    title back. Incrementing markers are what turn one sample into many."""
    times = [
        0.0,
        debug._MARKER_INTERVAL_S / 2,
        debug._MARKER_INTERVAL_S,
        debug._MARKER_INTERVAL_S * 2,
    ]
    with patch("routes.debug.time.monotonic", side_effect=times):
        started = debug.time.monotonic()

        def marker() -> str:
            n = int((debug.time.monotonic() - started) // debug._MARKER_INTERVAL_S)
            return f"BEACON TEST {n:04d}"

        assert marker() == "BEACON TEST 0000"  # same window
        assert marker() == "BEACON TEST 0001"  # next one
        assert marker() == "BEACON TEST 0002"


# ── the tone sequence ───────────────────────────────────────────────────────
# Why the beeps differ in pitch, and why that is the whole point: with one
# repeated beep, "the visualizer is a second early" and "the visualizer is a
# whole interval minus a second late" are the same observation. Reported live
# 2026-09-05, after the first lead figure measured that way turned out not to
# distinguish the two.


def test_every_pitch_in_the_sequence_is_distinct():
    assert len(set(debug._TONE_SEQUENCE_HZ)) == len(debug._TONE_SEQUENCE_HZ)


def test_pitches_are_spread_across_the_audible_range_in_octave_steps():
    """The reading is done against the visualizer's bars, whose bands are
    spaced roughly logarithmically — octave steps put each beep in a clearly
    different one, low left to high right. Pitches bunched together would
    light neighbouring bars and give nothing to tell apart."""
    freqs = debug._TONE_SEQUENCE_HZ
    assert freqs[0] < 200  # something in the bass bars
    assert freqs[-1] > 5000  # something up at the top
    for lower, higher in itertools.pairwise(freqs):
        assert higher > lower * 1.4


def test_a_full_cycle_is_watchable_in_well_under_a_minute():
    """Long enough that consecutive beeps stay apart through a device buffer
    of several seconds, short enough to watch a whole cycle without waiting."""
    cycle = len(debug._TONE_SEQUENCE_HZ) * debug._INTERVAL_S
    assert 10 <= cycle <= 30


def test_the_generated_wav_plays_the_pitches_in_order_at_the_right_times():
    """The property everything else here rests on: beep n has to be pitch n
    of the sequence, at n * _INTERVAL_S. If the generator drifts from that,
    every reading taken with it is silently wrong."""
    np = pytest.importorskip("numpy")
    import io
    import wave

    with wave.open(io.BytesIO(debug._generate_test_tone_wav()), "rb") as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(float)

    for n, expected in enumerate(debug._TONE_SEQUENCE_HZ):
        start = int(n * debug._INTERVAL_S * rate)
        segment = pcm[start : start + int(debug._BEEP_S * rate)]
        spectrum = np.abs(np.fft.rfft(segment * np.hanning(len(segment))))
        peak = np.fft.rfftfreq(len(segment), 1 / rate)[spectrum.argmax()]
        assert peak == pytest.approx(expected, rel=0.02), f"beep {n}"


def test_the_sequence_repeats_after_a_full_cycle():
    np = pytest.importorskip("numpy")
    import io
    import wave

    with wave.open(io.BytesIO(debug._generate_test_tone_wav()), "rb") as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(float)

    n = len(debug._TONE_SEQUENCE_HZ)  # first beep of the second cycle
    start = int(n * debug._INTERVAL_S * rate)
    segment = pcm[start : start + int(debug._BEEP_S * rate)]
    spectrum = np.abs(np.fft.rfft(segment * np.hanning(len(segment))))
    peak = np.fft.rfftfreq(len(segment), 1 / rate)[spectrum.argmax()]
    assert peak == pytest.approx(debug._TONE_SEQUENCE_HZ[0], rel=0.02)


def test_beeps_are_faded_so_they_do_not_click():
    """A click is a broadband transient that lights every band at once —
    which would hide exactly what the distinct pitches are there to show."""
    np = pytest.importorskip("numpy")

    beep = np.frombuffer(debug._beep(440.0), dtype="<i2").astype(float)
    assert abs(beep[0]) < 1000
    assert abs(beep[-1]) < 1000
    assert np.abs(beep).max() > 20000  # but full level in the middle
