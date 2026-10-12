"""Tests for core/mix_timeline.py — stream time back to song and position."""

import pytest

from core.mix_timeline import SAMPLE_RATE, Timeline

SR = SAMPLE_RATE


def test_nothing_is_heard_before_the_first_entry():
    assert Timeline().at(0) is None


def test_a_song_runs_from_where_it_started():
    t = Timeline()
    t.mark(0, "a", 0, 42.0, playing=True)
    heard = t.at(10 * SR)
    assert heard.song_id == "a"
    assert heard.position == pytest.approx(52.0)


def test_a_song_change_sits_on_its_exact_frame():
    t = Timeline()
    t.mark(0, "a", 0, 0.0, playing=True)
    t.mark(1000, "b", 1, 0.0, playing=True)
    assert t.at(999).song_id == "a"
    assert t.at(1000).song_id == "b"
    assert t.at(1000).position == 0.0


def test_a_hold_keeps_the_position_until_audio_comes_back():
    t = Timeline()
    t.mark(0, "a", 0, 0.0, playing=True)
    t.mark(5 * SR, "a", 0, 5.0, playing=False)
    t.mark(7 * SR, "a", 0, 5.0, playing=True)
    assert t.at(6 * SR).position == pytest.approx(5.0)
    assert t.at(8 * SR).position == pytest.approx(6.0)


def test_a_stretched_song_moves_at_its_rate():
    t = Timeline()
    t.mark(0, "b", 1, 0.0, playing=True, rate=1.05)
    assert t.at(10 * SR).position == pytest.approx(10.5)


def test_the_next_change_skips_holds_and_rate_steps_of_the_same_song():
    t = Timeline()
    t.mark(0, "a", 0, 0.0, playing=True)
    t.mark(SR, "a", 0, 1.0, playing=False)
    t.mark(2 * SR, "a", 0, 1.0, playing=True, rate=1.02)
    t.mark(3 * SR, "b", 1, 0.0, playing=True)
    assert t.next_change(0).song_id == "b"
    assert t.next_change(3 * SR) is None


def test_the_same_song_again_at_another_queue_index_is_a_change():
    """Repeat-one, or a song queued twice: the follower must still move the
    queue on."""
    t = Timeline()
    t.mark(0, "a", 0, 0.0, playing=True)
    t.mark(SR, "a", 1, 0.0, playing=True)
    assert t.next_change(0).frame == SR


def test_the_end_is_a_change_and_is_remembered():
    t = Timeline()
    t.mark(0, "a", 0, 0.0, playing=True)
    t.mark_end(4 * SR)
    assert t.next_change(0).song_id is None
    assert t.end_frame == 4 * SR
    assert t.at(5 * SR).song_id is None


def test_a_mark_on_the_same_frame_replaces_the_last():
    t = Timeline()
    t.mark(0, "a", 0, 0.0, playing=True)
    t.mark(0, "b", 1, 0.0, playing=True)
    assert len(t.entries) == 1
    assert t.at(0).song_id == "b"


def test_time_cannot_go_backwards():
    t = Timeline()
    t.mark(100, "a", 0, 0.0, playing=True)
    with pytest.raises(ValueError):
        t.mark(50, "b", 1, 0.0, playing=True)


def test_pruning_keeps_the_entry_still_in_force():
    t = Timeline()
    t.mark(0, "a", 0, 0.0, playing=True)
    t.mark(10 * SR, "b", 1, 0.0, playing=True)
    t.mark(20 * SR, "c", 2, 0.0, playing=True)
    t.prune(15 * SR)
    assert [e.song_id for e in t.entries] == ["b", "c"]
    assert t.at(15 * SR).position == pytest.approx(5.0)


def test_the_same_song_starting_over_is_a_change():
    """Repeat-one in a mix: same song, same queue entry, played again."""
    t = Timeline()
    t.mark(0, "a", 0, 0.0, playing=True, starts=True)
    t.mark(SR, "a", 0, 1.0, playing=False)
    t.mark(2 * SR, "a", 0, 0.0, playing=True, starts=True)
    assert t.next_change(0).frame == 2 * SR
    assert t.to_json()[2]["start"] is True and t.to_json()[1]["start"] is False
