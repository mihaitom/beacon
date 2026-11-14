"""core/replay_gain.py - the gain connect applies to a song it starts by
itself. Mirrors services/replayGain.ts, which works out the one the app
starts."""

import pytest

from core.replay_gain import gain_for, multiplier
from core.state import AppState
from media.base import ReplayGain, Track


def test_off_or_no_data_leaves_the_song_alone():
    assert multiplier(ReplayGain(track_gain=-6.0), "off") == 1.0
    assert multiplier(None, "song") == 1.0
    assert multiplier(ReplayGain(track_peak=0.5), "song") == 1.0


def test_picks_the_gain_for_the_mode():
    rg = ReplayGain(track_gain=-6.0, album_gain=6.0)
    assert multiplier(rg, "song") == pytest.approx(0.501, abs=1e-3)
    assert multiplier(rg, "album") == pytest.approx(1.995, abs=1e-3)


def test_falls_back_to_the_other_gain():
    assert multiplier(ReplayGain(album_gain=-6.0), "song") == pytest.approx(0.501, abs=1e-3)
    assert multiplier(ReplayGain(track_gain=-6.0), "album") == pytest.approx(0.501, abs=1e-3)


def test_is_held_below_the_peak():
    """+12 dB on a song peaking at 0.5 would clip; 1/peak is the ceiling."""
    assert multiplier(ReplayGain(track_gain=12.0, track_peak=0.5), "song") == 2.0
    assert multiplier(ReplayGain(album_gain=12.0, album_peak=0.4), "album") == 2.5


def test_an_absurd_gain_is_ignored_rather_than_raising():
    assert multiplier(ReplayGain(track_gain=1e6), "song") == 1.0


def test_from_opensubsonic_keeps_only_numbers():
    assert ReplayGain.from_opensubsonic(None) is None
    assert ReplayGain.from_opensubsonic({}) is None
    assert ReplayGain.from_opensubsonic({"trackGain": "2.35 dB"}) is None
    assert ReplayGain.from_opensubsonic({"trackGain": 2}).track_gain == 2.0


def test_gain_for_prefers_the_apps_hint():
    state = AppState()
    state.replay_gain_mode = "song"
    track = Track(id="a", title="T", artist="A", duration=1, replay_gain=ReplayGain(-6.0))
    assert gain_for(state, track) == pytest.approx(0.501, abs=1e-3)
    state.song_hints = {"a": {"gain": 0.9}}
    assert gain_for(state, track) == 0.9
