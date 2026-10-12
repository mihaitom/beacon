"""Tests for core/preview.py — which part of a song a preview plays."""

import pytest

from core.local_mixes import SongEntry
from core.preview import EXCERPT_SECONDS, PreviewSongs, pick_excerpt


def test_the_loudest_stretch_is_played():
    # 300 s, a peak per second: quiet throughout, loud from 150 to 170.
    peaks = [0.3] * 300
    peaks[150:170] = [0.9] * 20
    assert pick_excerpt(peaks, 300.0) == (150.0, 170.0)


def test_intro_and_outro_are_left_out_however_loud():
    peaks = [0.3] * 300
    peaks[0:40] = [1.0] * 40
    peaks[260:300] = [1.0] * 40
    start, end = pick_excerpt(peaks, 300.0)
    assert start >= 60.0 and end <= 240.0


def test_equally_loud_throughout_takes_the_stretch_nearest_two_fifths_in():
    # A brickwalled master: nothing to tell the windows apart by.
    start, _ = pick_excerpt([0.98] * 300, 300.0)
    assert start == pytest.approx(120.0)


def test_without_a_waveform_from_a_fixed_point():
    assert pick_excerpt([], 300.0) == (105.0, 125.0)


@pytest.mark.parametrize(
    ("duration", "expected"),
    [
        (15.0, (0.0, 15.0)),  # shorter than an excerpt: all of it
        (30.0, (5.0, 25.0)),  # too short for the window: from the middle
        (0.0, (0.0, EXCERPT_SECONDS)),  # length unknown
    ],
)
def test_short_and_unknown_songs(duration, expected):
    assert pick_excerpt([0.5] * 300, duration) == expected


def _songs(waveforms: dict[str, list[float]]) -> PreviewSongs:
    entries = [SongEntry(id=sid, queue_index=i, duration=300.0) for i, sid in enumerate(waveforms)]

    async def url_fn(item):
        return f"u/{item.song_id}"

    async def waveform_fn(song_id, url):
        assert url == f"u/{song_id}"
        return waveforms[song_id]

    return PreviewSongs(entries, url_fn, waveform_fn)


async def test_each_song_plays_its_own_excerpt_and_the_list_ends():
    loud_late = [0.3] * 300
    loud_late[200:220] = [0.9] * 20
    songs = _songs({"a": [0.98] * 300, "b": loud_late})
    first = await songs.item(0)
    assert (first.song_id, first.start, first.end) == ("a", 120.0, 140.0)
    second = await songs.next_item(first)
    assert (second.song_id, second.queue_index, second.start) == ("b", 1, 200.0)
    assert await songs.next_item(second) is None
