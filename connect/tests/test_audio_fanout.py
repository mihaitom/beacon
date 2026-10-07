"""Tests for core/audio_fanout.py — what the radio relay's own tests do not
cover: the stream-time tags the listen-along broadcast hands its guests.
The rest of the fan-out is exercised through test_radio_relay.py."""

from core.audio_fanout import AudioFanout


def _fanout() -> AudioFanout:
    return AudioFanout(lambda: (60.0, 1_000_000))


def test_a_burst_listener_starts_at_the_oldest_chunk_it_is_handed():
    fanout = _fanout()
    fanout.publish(b"one", tag=1.0)
    fanout.publish(b"two", tag=2.0)
    q = fanout.subscribe(burst=True)
    assert fanout.start_tag(q) == 1.0
    assert q.get_nowait() == b"one"


def test_a_listener_with_nothing_handed_yet_starts_at_the_next_chunk():
    fanout = _fanout()
    q = fanout.subscribe(burst=True)
    assert fanout.start_tag(q) is None
    fanout.publish(b"one", tag=4.5)
    fanout.publish(b"two", tag=5.5)
    assert fanout.start_tag(q) == 4.5


def test_a_listener_without_a_burst_starts_at_the_live_edge():
    fanout = _fanout()
    fanout.publish(b"old", tag=1.0)
    q = fanout.subscribe()
    fanout.publish(b"new", tag=2.0)
    assert fanout.start_tag(q) == 2.0
    assert q.get_nowait() == b"new"


def test_untagged_audio_leaves_no_start():
    fanout = _fanout()
    q = fanout.subscribe(burst=True)
    fanout.publish(b"radio")
    assert fanout.start_tag(q) is None


def test_a_listener_that_left_is_forgotten():
    fanout = _fanout()
    q = fanout.subscribe()
    fanout.publish(b"x", tag=1.0)
    fanout.unsubscribe(q)
    assert fanout.start_tag(q) is None
    assert fanout.listeners == 0
