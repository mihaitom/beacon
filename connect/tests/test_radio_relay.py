"""Tests for core/radio_relay.py — the shared radio-to-cast relay."""

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import core.radio_relay as relay_mod
from core.radio_relay import RadioRelay, _device_output_args


def _drain(q: asyncio.Queue) -> list:
    return [q.get_nowait() for _ in range(q.qsize())]


def _icy_block(audio: bytes, title: str | None) -> bytes:
    """Mirrors test_icy_metadata.py's own helper — kept local rather than
    imported, since a relay test importing from a route-adjacent test
    module would be an odd direction of dependency."""
    if title is None:
        return audio + b"\x00"
    text = f"StreamTitle='{title}';".encode()
    padded_len = -(-len(text) // 16) * 16
    return audio + bytes([padded_len // 16]) + text.ljust(padded_len, b"\x00")


def _mock_stream(headers: dict, chunks: list[bytes]):
    resp = MagicMock()
    resp.headers = headers
    resp.raise_for_status = MagicMock()

    async def aiter_bytes():
        for chunk in chunks:
            yield chunk

    resp.aiter_bytes = aiter_bytes

    @asynccontextmanager
    async def stream(method, url, headers=None):
        yield resp

    return stream


class FakeStdin:
    def __init__(self):
        self.written = bytearray()
        self.closed = False

    def write(self, data: bytes) -> None:
        self.written.extend(data)

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class FakeStdout:
    def __init__(self, chunks: list[bytes] | None = None):
        self._chunks = list(chunks or [])

    async def read(self, n: int) -> bytes:
        if self._chunks:
            await asyncio.sleep(0)  # one real yield per chunk, for deterministic interleaving
            return self._chunks.pop(0)
        # EOF once exhausted — the same as a real pipe once ffmpeg's own
        # process has ended/been killed, which is the only way a real
        # _fan_out_audio() loop ends on its own (see its own code: `if not
        # chunk: return`). Not "blocks forever, only ends via cancellation":
        # _run_once()'s finally awaits this task directly, which a
        # never-ending fake would hang.
        return b""


class FakeProc:
    def __init__(self, stdout_chunks: list[bytes] | None = None):
        self.stdin = FakeStdin()
        self.stdout = FakeStdout(stdout_chunks)
        self.killed = False

    def kill(self) -> None:
        self.killed = True


def _relay_with_fake_ffmpeg(url="http://station", content_type="audio/mpeg", stdout_chunks=None):
    """A RadioRelay whose _start_ffmpeg() is replaced with a fake process —
    exercises the ICY-demux/fan-out/reconnect logic this module actually
    owns, without a real ffmpeg or real OS pipes (the pipe wiring itself is
    plain, well-documented asyncio boilerplate — see _start_ffmpeg's own
    command-construction test below for what *is* covered there)."""
    titles: list[str] = []
    relay = RadioRelay(url, content_type, titles.append)
    proc = FakeProc(stdout_chunks)

    async def fake_start_ffmpeg():
        relay._proc = proc
        return proc

    relay._start_ffmpeg = fake_start_ffmpeg
    return relay, proc, titles


class TestDeviceOutputArgs:
    def test_copies_an_already_mp3_station(self):
        args, content_type = _device_output_args("audio/mpeg")
        assert args == relay_mod._COPY_ARGS
        assert content_type == "audio/mpeg"

    def test_reencodes_anything_else_to_the_192k_fallback(self):
        args, content_type = _device_output_args("audio/aacp")
        assert args == relay_mod._FALLBACK_DEVICE_ARGS
        assert content_type == "audio/mpeg"


def _stalling_stream(attempts: list[str], chunks: list[bytes], gap: float):
    """A station that answers, sends `chunks` `gap` seconds apart, and then
    stops sending without ever closing the connection. `attempts` records
    each connection so a test can see whether the relay reconnected.

    This is the shape that matters: httpx's own read timeout is
    deliberately off for a live stream (_TIMEOUT), so nothing raises, and
    aiter_bytes() simply never yields again."""

    def stream(method, url, headers=None):
        attempts.append(url)
        resp = MagicMock()
        resp.headers = {}
        resp.raise_for_status = MagicMock()

        async def aiter_bytes():
            for chunk in chunks:
                await asyncio.sleep(gap)
                yield chunk
            await asyncio.sleep(3600)  # open, silent, never closed

        resp.aiter_bytes = aiter_bytes

        @asynccontextmanager
        async def cm():
            yield resp

        return cm()

    return stream


class TestRadioRelayBurst:
    """The few seconds of already-relayed audio a listener's own player is
    handed on arrival. Everything this relay emits is paced to real time,
    so without it a player fed from here receives exactly one second of
    audio per second and holds no buffer at all — which is what turns a
    routine few seconds of no signal, away from home, into silence."""

    async def test_hands_a_listener_the_recent_audio_up_front(self):
        relay, _proc, _ = _relay_with_fake_ffmpeg(stdout_chunks=[b"chunk-1", b"chunk-2"])
        stream = _mock_stream({}, [])

        with patch.object(relay_mod._client, "stream", stream):
            await relay.start()
            for _ in range(4):
                await asyncio.sleep(0)
            # Subscribing *after* those chunks have already gone past.
            q = relay.subscribe_audio(burst=True)
            await relay.stop()

        assert _drain(q)[:2] == [b"chunk-1", b"chunk-2"]

    async def test_starts_a_device_at_the_live_edge_instead(self):
        """A speaker is on the same network as this backend and gains
        nothing from lagging; the radio position tracking built around the
        relay (core/radio_position.py) would only be further out."""
        relay, _proc, _ = _relay_with_fake_ffmpeg(stdout_chunks=[b"chunk-1", b"chunk-2"])
        stream = _mock_stream({}, [])

        with patch.object(relay_mod._client, "stream", stream):
            await relay.start()
            for _ in range(4):
                await asyncio.sleep(0)
            q = relay.subscribe_audio()
            await relay.stop()

        # Only stop()'s own sentinel — none of the audio already past.
        assert _drain(q) == [None]

    async def test_forgets_audio_from_before_an_outage(self):
        """Trimmed by age, which is what empties this by itself while a
        station is down: handing a listener reconnecting after a minute of
        nothing the sixty-second-old seconds before it would be replaying
        the past, not filling a buffer."""
        relay, _proc, _ = _relay_with_fake_ffmpeg(stdout_chunks=[b"old-audio"])
        stream = _mock_stream({}, [])

        with (
            patch.object(relay_mod, "_BURST_SECONDS", 0.01),
            patch.object(relay_mod._client, "stream", stream),
        ):
            await relay.start()
            await asyncio.sleep(0)
            await asyncio.sleep(0.05)
            q = relay.subscribe_audio(burst=True)
            await relay.stop()

        assert _drain(q) == [None]

    async def test_caps_what_it_keeps(self):
        chunks = [b"x" * 8192 for _ in range(40)]
        relay, _proc, _ = _relay_with_fake_ffmpeg(stdout_chunks=chunks)
        stream = _mock_stream({}, [])

        with (
            patch.object(relay_mod, "_BURST_MAX_BYTES", 16384),
            patch.object(relay_mod._client, "stream", stream),
        ):
            await relay.start()
            for _ in range(len(chunks) + 2):
                await asyncio.sleep(0)
            assert relay._burst_bytes <= 16384
            await relay.stop()


class TestRadioRelayStallDetection:
    """A station that goes quiet without closing the connection. Nothing
    else in the stack notices one: the relay used to sit on the dead
    connection for as long as the radio was left playing, and every
    subscriber — a speaker, the app's own player — was left to work it out
    from silence, much later."""

    async def test_reconnects_a_station_that_stops_sending(self):
        relay, _proc, _ = _relay_with_fake_ffmpeg()
        attempts: list[str] = []
        stream = _stalling_stream(attempts, [b"audio"], gap=0.0)

        with (
            patch.object(relay_mod, "_STALL_TIMEOUT_SECONDS", 0.02),
            patch.object(relay_mod, "_RECONNECT_DELAY_SECONDS", 0.01),
            patch.object(relay_mod._client, "stream", stream),
        ):
            await relay.start()
            await asyncio.sleep(0.25)
            await relay.stop()

        assert len(attempts) >= 2, attempts

    async def test_leaves_a_station_that_is_merely_slow_alone(self):
        """The gap this measures is only ever the tail of a read paced from
        the far end by ffmpeg's own -readrate, so it has to tolerate a
        station trickling rather than bursting — dropping one of those
        would guarantee a gap in the sound where there was none."""
        relay, proc, _ = _relay_with_fake_ffmpeg()
        attempts: list[str] = []
        stream = _stalling_stream(attempts, [b"a", b"b", b"c", b"d"], gap=0.01)

        with (
            patch.object(relay_mod, "_STALL_TIMEOUT_SECONDS", 0.15),
            patch.object(relay_mod._client, "stream", stream),
        ):
            await relay.start()
            await asyncio.sleep(0.1)
            await relay.stop()

        assert attempts == ["http://station"]
        assert bytes(proc.stdin.written) == b"abcd"


class TestRadioRelayFetchLoop:
    async def test_feeds_only_demultiplexed_audio_to_ffmpeg_stdin(self):
        metaint = 8
        chunk = _icy_block(b"a" * metaint, "Artist - Track")
        relay, proc, titles = _relay_with_fake_ffmpeg()
        stream = _mock_stream({"icy-metaint": str(metaint)}, [chunk])

        with patch.object(relay_mod._client, "stream", stream):
            await relay.start()
            await asyncio.sleep(0)
            await relay.stop()

        assert bytes(proc.stdin.written) == b"a" * metaint
        assert titles == ["Artist - Track"]

    async def test_passes_raw_bytes_through_untouched_when_the_station_has_no_icy_metaint(self):
        relay, proc, _ = _relay_with_fake_ffmpeg()
        stream = _mock_stream({}, [b"plain-audio-bytes"])

        with patch.object(relay_mod._client, "stream", stream):
            await relay.start()
            await asyncio.sleep(0)
            await relay.stop()

        assert bytes(proc.stdin.written) == b"plain-audio-bytes"

    async def test_fans_out_device_audio_to_every_subscriber(self):
        relay, _proc, _ = _relay_with_fake_ffmpeg(stdout_chunks=[b"chunk-1", b"chunk-2"])
        stream = _mock_stream({}, [])  # empty station body — only stdout matters here

        with patch.object(relay_mod._client, "stream", stream):
            await relay.start()
            q1 = relay.subscribe_audio()
            q2 = relay.subscribe_audio()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            first_1, second_1 = await q1.get(), await q1.get()
            first_2, second_2 = await q2.get(), await q2.get()
            await relay.stop()

        assert (first_1, second_1) == (b"chunk-1", b"chunk-2")
        assert (first_2, second_2) == (b"chunk-1", b"chunk-2")

    async def test_a_lossy_subscriber_keeps_the_newest_audio_not_the_oldest(self):
        """The visualizer's analyzer asks for lossy. A device must never
        lose a byte, so its full queue drops the *newest* chunk — but for
        analysis that is exactly backwards: it would preserve a backlog of
        audio already played, which cannot be caught up with on a live
        source and costs full-speed decode+FFT to work through, starving
        the loop device audio is paced on. Heard live 2026-09-03 as
        speaker dropouts with a frozen visualizer."""
        chunks = [b"c%d" % i for i in range(relay_mod._ANALYSIS_QUEUE_MAXSIZE + 3)]
        relay, _proc, _ = _relay_with_fake_ffmpeg(stdout_chunks=chunks)
        stream = _mock_stream({}, [])

        with patch.object(relay_mod._client, "stream", stream):
            await relay.start()
            q = relay.subscribe_audio(lossy=True)  # never read from
            for _ in range(len(chunks) + 4):
                await asyncio.sleep(0)
            await relay.stop()

        held = []
        while not q.empty():
            item = q.get_nowait()
            if item is not None:
                held.append(item)
        assert len(held) <= relay_mod._ANALYSIS_QUEUE_MAXSIZE
        # The live edge survived; the start of the stream was discarded.
        assert chunks[-1] in held
        assert chunks[0] not in held

    async def test_a_device_subscriber_still_keeps_the_oldest_audio(self):
        """Unchanged for devices: a gap in their audio is audible, so a
        slow one falls behind rather than skipping forward. Exercised by
        actually overflowing its queue — with the real 4000-entry size
        nothing here would ever reach it, and the test would pass without
        testing anything."""
        size = 4
        chunks = [b"c%d" % i for i in range(size + 3)]
        relay, _proc, _ = _relay_with_fake_ffmpeg(stdout_chunks=chunks)
        stream = _mock_stream({}, [])

        with (
            patch.object(relay_mod, "_AUDIO_QUEUE_MAXSIZE", size),
            patch.object(relay_mod._client, "stream", stream),
        ):
            await relay.start()
            q = relay.subscribe_audio()  # never read from
            for _ in range(len(chunks) + 4):
                await asyncio.sleep(0)
            await relay.stop()

        held = []
        while not q.empty():
            item = q.get_nowait()
            if item is not None:
                held.append(item)
        # Subscribing happens after start(), so the very first chunk may
        # already have gone out — anchor on whatever this reader's own
        # first chunk turned out to be.
        held_start = chunks.index(held[0])
        # What a device still has waiting is the earlier audio; the chunks
        # it could not take are the newest ones — the opposite of the lossy
        # subscriber above, which keeps the live edge instead.
        assert held == chunks[held_start : held_start + len(held)]  # contiguous, no skipping
        assert chunks[-1] not in held

    async def test_stop_sends_a_sentinel_to_every_subscriber_and_kills_the_process(self):
        relay, proc, _ = _relay_with_fake_ffmpeg()
        stream = _mock_stream({}, [])

        with patch.object(relay_mod._client, "stream", stream):
            await relay.start()
            q = relay.subscribe_audio()
            await relay.stop()

        assert proc.killed is True
        assert q.get_nowait() is None

    async def test_unsubscribe_stops_a_reader_from_receiving_further_chunks(self):
        relay, _proc, _ = _relay_with_fake_ffmpeg(stdout_chunks=[b"chunk-1", b"chunk-2"])
        stream = _mock_stream({}, [])

        with patch.object(relay_mod._client, "stream", stream):
            await relay.start()
            q = relay.subscribe_audio()
            await asyncio.sleep(0)
            relay.unsubscribe_audio(q)
            await asyncio.sleep(0)
            await relay.stop()

        assert q.empty()

    async def test_a_dropped_fetch_retries_without_tearing_down_subscribers(self):
        # First attempt raises before ever streaming a byte (station
        # connection refused); second attempt succeeds. Subscribers from
        # before the drop must still be usable afterwards — a transient
        # reconnect is not the same as stop() (see _fan_out_audio's own
        # comment on why it never sends the None sentinel itself).
        titles: list[str] = []
        relay = RadioRelay("http://station", "audio/mpeg", titles.append)
        attempts = 0

        @asynccontextmanager
        async def flaky_stream(method, url, headers=None):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise ConnectionError("refused")
            resp = MagicMock()
            resp.headers = {}
            resp.raise_for_status = MagicMock()

            async def aiter_bytes():
                yield b"audio-after-reconnect"

            resp.aiter_bytes = aiter_bytes
            yield resp

        proc = FakeProc()

        async def fake_start_ffmpeg():
            relay._proc = proc
            return proc

        relay._start_ffmpeg = fake_start_ffmpeg

        with (
            patch.object(relay_mod._client, "stream", flaky_stream),
            patch.object(relay_mod.asyncio, "sleep", AsyncMock()),
        ):
            q = None
            task = asyncio.create_task(relay._run())
            await relay.start()  # first (failing) attempt only
            q = relay.subscribe_audio()
            for _ in range(5):
                await asyncio.sleep(0)
            await relay.stop()
            task.cancel()

        assert attempts >= 2
        assert (
            q is not None and not q.empty()
        )  # got the sentinel from stop(), not silently torn down

    # ── Teardown must survive a subscriber that stopped reading ────────────
    # A full queue is an expected state, not an anomaly: _fan_out_audio()
    # deliberately lets a slow subscriber fall behind rather than stalling
    # everyone else behind it. stop() then has to deliver its sentinel into
    # exactly such a queue.

    async def test_stop_still_sentinels_a_subscriber_whose_queue_filled_up(self):
        """The specific bug: a plain put_nowait() raises QueueFull here, and
        that exception propagates all the way out of
        SessionState.stop_radio_relay() into /stop, play_tracks() and
        reap_once() — where it aborts the reap loop for every remaining
        session — while leaving the rest of the subscribers without their
        sentinel and the subscriber list uncleared."""
        relay, _proc, _ = _relay_with_fake_ffmpeg()
        stream = _mock_stream({}, [])

        with patch.object(relay_mod._client, "stream", stream):
            await relay.start()
            stalled = relay.subscribe_audio()
            healthy = relay.subscribe_audio()
            for _ in range(stalled.maxsize):
                stalled.put_nowait(b"backlog")
            await relay.stop()

        # The stalled reader gets its sentinel too — it is the only thing
        # that ever unblocks its _relayed_radio_audio() generator.
        assert stalled.get_nowait() is not None  # oldest chunk dropped for the sentinel
        assert _drain(stalled)[-1] is None
        assert healthy.get_nowait() is None
        assert relay._audio_subscribers == []

    # ── Subscribing to an already-stopped relay ────────────────────────────

    async def test_subscribing_after_stop_hands_back_an_already_finished_queue(self):
        """routes/stream.py's radio_stream() reads session.radio_relay and
        returns a StreamingResponse whose generator only subscribes once it
        is first iterated — a station change or /stop in between would
        otherwise leave that generator waiting forever on a queue nothing
        feeds, holding the device's connection open with no way to end it."""
        relay, _proc, _ = _relay_with_fake_ffmpeg()
        stream = _mock_stream({}, [])

        with patch.object(relay_mod._client, "stream", stream):
            await relay.start()
            await relay.stop()
            late_audio = relay.subscribe_audio()

        assert late_audio.get_nowait() is None
        # Not registered either — nothing must be able to grow the list a
        # completed stop() has already cleared.
        assert relay._audio_subscribers == []

    # ── start() must not block on a station that never answers ─────────────

    async def test_start_gives_up_waiting_on_a_station_that_never_answers(self):
        """/play-url calls start() while holding session.play_lock, and
        _TIMEOUT deliberately has no read timeout (a live stream never
        finishes reading), so an unbounded wait here would hang every
        subsequent /play and /play-url on the session behind it."""
        relay = RadioRelay("http://station", "audio/mpeg", lambda _: None)

        @asynccontextmanager
        async def never_answers(method, url, headers=None):
            await asyncio.Event().wait()  # headers that never arrive
            yield  # pragma: no cover

        with (
            patch.object(relay_mod._client, "stream", never_answers),
            patch.object(relay_mod, "_START_TIMEOUT_SECONDS", 0.01),
        ):
            await asyncio.wait_for(relay.start(), timeout=2)
            assert relay.connected is False
            await relay.stop()

    async def test_connected_reports_whether_the_first_attempt_produced_anything(self):
        relay, _proc, _ = _relay_with_fake_ffmpeg()
        stream = _mock_stream({}, [])

        with patch.object(relay_mod._client, "stream", stream):
            assert relay.connected is False
            await relay.start()
            assert relay.connected is True
            await relay.stop()

    async def test_a_station_that_refuses_the_connection_never_reports_connected(self):
        """start() still returns — _run() keeps retrying in the background —
        but /play-url has to be able to tell that there is nothing to point
        a device at yet, or it dispatches one at an endpoint that answers
        200 and then stays silent indefinitely."""
        relay, _proc, _ = _relay_with_fake_ffmpeg()

        @asynccontextmanager
        async def refused(method, url, headers=None):
            raise ConnectionError("refused")
            yield  # pragma: no cover

        # asyncio.sleep deliberately left real: _run()'s retry loop only
        # ever yields to the event loop through it, so mocking it out with
        # a station that never succeeds spins forever.
        with patch.object(relay_mod._client, "stream", refused):
            await relay.start()
            assert relay.connected is False
            await relay.stop()


async def test_start_ffmpeg_builds_the_expected_single_output_command():
    """Exercises the real _start_ffmpeg() — only the actual ffmpeg process
    itself faked — to check the command it builds. Single output only
    since 2026-09-03: this used to also carry a second, PCM output for the
    radio visualizer (see core/radio_relay.py's own module docstring for
    why that was removed) — the visualizer now decodes the station a
    second time with its own, independent ffmpeg instead."""
    relay = RadioRelay("http://station", "audio/mpeg", lambda _: None)
    captured: dict = {}

    async def fake_create_subprocess_exec(*cmd, **kwargs):
        captured["cmd"] = cmd
        return FakeProc()

    with patch("asyncio.create_subprocess_exec", fake_create_subprocess_exec):
        proc = await relay._start_ffmpeg()

    cmd = captured["cmd"]
    assert cmd[0] == "ffmpeg"
    assert "-i" in cmd and cmd[cmd.index("-i") + 1] == "pipe:0"
    assert cmd.count("-map") == 1
    assert cmd[-1] == "pipe:1"
    assert proc is relay._proc
    # Regression coverage for live-streamed stutter (2026-09-01) — without
    # -fflags/-flush_packets, ffmpeg buffers on both sides of the live
    # restream instead of flushing packets as they're ready; without
    # -readrate, nothing paces the station fetch at all, so a source
    # flushing its own send buffer in bursts runs straight through as a
    # burst. Local playback, which never touches this relay, was
    # unaffected either way.
    assert "-fflags" in cmd
    # Exactly once. It comes from core/streamer.py's _READRATE_ARGS, which
    # has always carried it; a second one added here would silently win
    # (ffmpeg takes the last value) and shorten the head start that whoever
    # is subscribed at relay start gets, casting included.
    assert cmd.count("-readrate_initial_burst") == 1
    assert cmd[cmd.index("-fflags") + 1] == "nobuffer"
    assert "-flush_packets" in cmd
    assert cmd[cmd.index("-flush_packets") + 1] == "1"
    assert "-readrate" in cmd
    assert cmd[cmd.index("-readrate") + 1] == "1"
    # -readrate is an input option — must sit before -i to apply to it.
    assert cmd.index("-readrate") < cmd.index("-i")


# ── SessionState.stop_radio_relay() — radio_icy_* fields share
# radio_position_tracker's own lifetime boundary ────────────────────────────


async def test_stop_radio_relay_clears_the_icy_round_trip_fields(default_session):
    """core/session.py's own comment: radio_position_tracker "shares this
    exact lifetime boundary" with a relay — the ICY round-trip fields added
    2026-09-04 (core/session.py's radio_icy_pending_injection/radio_icy_
    measured_lag) need the same treatment, or a stale measurement from a
    previous station could leak into a fresh one's visualizer clock."""
    default_session.radio_icy_pending_injection = ("Old Title", 123.0)
    default_session.radio_icy_measured_lag = 3.2

    await default_session.stop_radio_relay()

    assert default_session.radio_icy_pending_injection is None
    assert default_session.radio_icy_measured_lag is None
