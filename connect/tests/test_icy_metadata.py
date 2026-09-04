"""Tests for core/icy_metadata.py — reading a radio stream's ICY
"now playing" tag."""

import logging
from contextlib import asynccontextmanager
from unittest.mock import MagicMock, patch

import httpx

import core.icy_metadata as icy_mod


def _icy_block(audio: bytes, title: str | None) -> bytes:
    """One metaint-sized chunk of audio, followed by its own metadata block
    - a length byte (in units of 16) and that many bytes of `StreamTitle=`
    text, padded with nulls to the next 16-byte boundary. `title=None`
    produces a zero-length block (no title change this tick), same as a
    real stream's silent majority of blocks."""
    if title is None:
        return audio + b"\x00"
    text = f"StreamTitle='{title}';".encode()
    padded_len = -(-len(text) // 16) * 16  # round up to the next multiple of 16
    return audio + bytes([padded_len // 16]) + text.ljust(padded_len, b"\x00")


def _mock_stream(headers: dict, chunks: list[bytes]):
    """Mocks _client.stream("GET", url, headers=...) — an async context
    manager yielding a response whose .aiter_bytes() streams `chunks`."""
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


class TestIcyDemuxer:
    """IcyDemuxer is what _watch_once() now delegates to, and the only
    thing core/radio_relay.py's RadioRelay reuses from this module - these
    exercise the audio-byte return value directly, which _watch_once()
    itself never needed and so never had its own test coverage for."""

    def test_returns_the_audio_bytes_and_reports_the_title(self):
        metaint = 8
        block = icy_mod.IcyDemuxer(metaint, (titles := []).append)

        audio = block.feed(_icy_block(b"a" * metaint, "Artist - Track"))

        assert audio == b"a" * metaint
        assert titles == ["Artist - Track"]

    def test_holds_back_audio_until_a_split_metadata_block_completes(self):
        metaint = 8
        titles = []
        demuxer = icy_mod.IcyDemuxer(metaint, titles.append)
        whole = _icy_block(b"a" * metaint, "Artist - Track")
        first_half, second_half = whole[:10], whole[10:]

        audio_1 = demuxer.feed(first_half)
        assert titles == []  # metadata block not complete yet
        audio_2 = demuxer.feed(second_half)

        assert audio_1 + audio_2 == b"a" * metaint
        assert titles == ["Artist - Track"]

    def test_passes_through_audio_across_several_silent_blocks(self):
        metaint = 4
        demuxer = icy_mod.IcyDemuxer(metaint, lambda _: None)
        chunk = (
            _icy_block(b"a" * metaint, None)
            + _icy_block(b"b" * metaint, None)
            + _icy_block(b"c" * metaint, None)
        )

        audio = demuxer.feed(chunk)

        assert audio == b"aaaabbbbcccc"

    def test_never_calls_back_for_a_zero_length_metadata_block(self):
        metaint = 4
        demuxer = icy_mod.IcyDemuxer(metaint, (titles := []).append)

        demuxer.feed(_icy_block(b"x" * metaint, None))

        assert titles == []


class TestIcyMuxer:
    """The mirror image of IcyDemuxer, for routes/stream.py's own re-served
    radio endpoints — see IcyMuxer's own docstring for why this exists.
    Round-trips through IcyDemuxer/`_icy_block()` where useful, since that's
    the exact framing a real device (or this module's own demuxer) expects
    back out."""

    def test_no_title_known_yet_emits_zero_length_blocks(self):
        metaint = 4
        muxer = icy_mod.IcyMuxer(metaint, lambda: None)

        out = muxer.feed(b"a" * metaint)

        assert out == _icy_block(b"a" * metaint, None)

    def test_emits_a_real_block_for_the_current_title(self):
        metaint = 8
        muxer = icy_mod.IcyMuxer(metaint, lambda: "Artist - Track")

        out = muxer.feed(b"a" * metaint)

        assert out == _icy_block(b"a" * metaint, "Artist - Track")

    def test_does_not_repeat_an_unchanged_title(self):
        """Same convention a real station follows and IcyDemuxer.feed()
        already expects on the way in: a block is only a real StreamTitle
        payload the tick the title *changes*, zero-length every other
        tick — repeating the full payload every block would work too, but
        the whole point of the convention is not paying for that."""
        metaint = 4
        muxer = icy_mod.IcyMuxer(metaint, lambda: "Artist - Track")

        first = muxer.feed(b"a" * metaint)
        second = muxer.feed(b"b" * metaint)

        assert first == _icy_block(b"a" * metaint, "Artist - Track")
        assert second == _icy_block(b"b" * metaint, None)

    def test_a_later_title_change_is_picked_up(self):
        metaint = 4
        titles = iter(["First Title", "First Title", "Second Title"])
        muxer = icy_mod.IcyMuxer(metaint, lambda: next(titles))

        blocks = [muxer.feed(b"a" * metaint) for _ in range(3)]

        assert blocks[0] == _icy_block(b"a" * metaint, "First Title")
        assert blocks[1] == _icy_block(b"a" * metaint, None)
        assert blocks[2] == _icy_block(b"a" * metaint, "Second Title")

    def test_boundaries_do_not_need_to_line_up_with_feed_calls(self):
        """Same reason IcyDemuxer.feed() buffers on the way in: a chunk
        from the relay's own fan-out (8KiB reads, core/radio_relay.py) has
        no reason to land exactly on a metaint boundary."""
        metaint = 6
        muxer = icy_mod.IcyMuxer(metaint, lambda: None)

        out = b"".join(muxer.feed(bytes([b])) for b in range(metaint * 2))

        assert out == _icy_block(bytes(range(metaint)), None) + _icy_block(
            bytes(range(metaint, metaint * 2)), None
        )

    def test_round_trips_through_icy_demuxer(self):
        """The actual contract: whatever this produces, a real device's own
        ICY parser (or this module's own IcyDemuxer, standing in for one)
        must be able to read straight back — audio bytes recovered exactly,
        and every title change reported once."""
        metaint = 5
        titles = iter(["Song A", "Song A", "Song B", "Song B"])
        muxer = icy_mod.IcyMuxer(metaint, lambda: next(titles))
        source = [b"12345", b"67890", b"abcde", b"fghij"]

        muxed = b"".join(muxer.feed(chunk) for chunk in source)

        demuxer = icy_mod.IcyDemuxer(metaint, (seen := []).append)
        audio = demuxer.feed(muxed)

        assert audio == b"".join(source)
        assert seen == ["Song A", "Song B"]

    def test_on_inject_fires_only_for_real_title_changes(self):
        """routes/stream.py's own record_injection() (and, downstream,
        routes/upnp.py's ICY round-trip measurement) only cares about real
        title changes — not the zero-length "nothing changed" blocks that
        make up the overwhelming majority of them."""
        metaint = 4
        titles = iter(["Song A", "Song A", "Song A", "Song B"])
        injected = []
        muxer = icy_mod.IcyMuxer(metaint, lambda: next(titles), injected.append)

        for _ in range(4):
            muxer.feed(b"a" * metaint)

        assert injected == ["Song A", "Song B"]

    def test_on_inject_is_never_called_for_a_none_title(self):
        metaint = 4
        muxer = icy_mod.IcyMuxer(metaint, lambda: None, (injected := []).append)

        muxer.feed(b"a" * metaint)

        assert injected == []

    def test_works_without_an_on_inject_callback(self):
        """The default (None) — most callers of IcyMuxer don't care about
        this at all, and omitting it must not raise."""
        metaint = 4
        muxer = icy_mod.IcyMuxer(metaint, lambda: "Title")

        out = muxer.feed(b"a" * metaint)

        assert out == _icy_block(b"a" * metaint, "Title")


class TestWatchOnce:
    async def test_gives_up_immediately_when_the_station_declares_no_metaint(self):
        stream = _mock_stream({}, [b"whatever"])
        titles = []
        with patch.object(icy_mod._client, "stream", stream):
            worth_retrying = await icy_mod._watch_once("http://station", titles.append)
        assert worth_retrying is False
        assert titles == []

    async def test_extracts_a_single_title(self):
        metaint = 8
        chunk = _icy_block(b"a" * metaint, "Artist - Track")
        stream = _mock_stream({"icy-metaint": str(metaint)}, [chunk])
        titles = []
        with patch.object(icy_mod._client, "stream", stream):
            worth_retrying = await icy_mod._watch_once("http://station", titles.append)
        assert worth_retrying is True
        assert titles == ["Artist - Track"]

    async def test_reports_only_when_the_title_actually_changes_in_the_source(self):
        # The source itself repeats the same StreamTitle block on every
        # metadata tick until the track actually changes - this just checks
        # that a real track change downstream (two distinct titles) both
        # come through, not that repeats get deduplicated (they're each a
        # separate on_title_change call; stores/playback.ts's own state
        # assignment is what makes a same-value update a no-op).
        metaint = 8
        audio = b"a" * metaint
        chunks = [
            _icy_block(audio, "Song One"),
            _icy_block(audio, None),
            _icy_block(audio, "Song Two"),
        ]
        stream = _mock_stream({"icy-metaint": str(metaint)}, chunks)
        titles = []
        with patch.object(icy_mod._client, "stream", stream):
            await icy_mod._watch_once("http://station", titles.append)
        assert titles == ["Song One", "Song Two"]

    async def test_reassembles_a_metadata_block_split_across_network_chunks(self):
        metaint = 8
        block = _icy_block(b"a" * metaint, "Split Title")
        # However the network happens to fragment it, the byte content is
        # identical - split well inside the metadata block itself, not on
        # some convenient boundary.
        split_at = metaint + 3
        stream = _mock_stream({"icy-metaint": str(metaint)}, [block[:split_at], block[split_at:]])
        titles = []
        with patch.object(icy_mod._client, "stream", stream):
            await icy_mod._watch_once("http://station", titles.append)
        assert titles == ["Split Title"]

    async def test_ignores_a_blank_title(self):
        metaint = 8
        chunk = _icy_block(b"a" * metaint, "")
        stream = _mock_stream({"icy-metaint": str(metaint)}, [chunk])
        titles = []
        with patch.object(icy_mod._client, "stream", stream):
            await icy_mod._watch_once("http://station", titles.append)
        assert titles == []


class TestWatch:
    async def test_returns_for_good_on_a_station_with_no_icy_support(self):
        stream = _mock_stream({}, [b"whatever"])
        with (
            patch.object(icy_mod._client, "stream", stream),
            patch.object(icy_mod.asyncio, "sleep") as mock_sleep,
        ):
            await icy_mod.watch("http://station", lambda t: None)
        mock_sleep.assert_not_called()

    async def test_reconnects_after_a_drop_and_keeps_reporting_titles(self):
        metaint = 8
        chunk = _icy_block(b"a" * metaint, "Artist - Track")
        call_count = 0

        @asynccontextmanager
        async def stream(method, url, headers=None):
            nonlocal call_count
            call_count += 1
            resp = MagicMock()
            resp.headers = {"icy-metaint": str(metaint)}
            resp.raise_for_status = MagicMock()

            async def aiter_bytes():
                yield chunk
                if call_count == 1:
                    raise httpx.ReadError("dropped")

            resp.aiter_bytes = aiter_bytes
            yield resp

        titles = []

        # A plain sentinel exception to break watch()'s otherwise-infinite
        # loop once the reconnect this test cares about has been proven -
        # watch() itself has no other exit condition while metadata keeps
        # coming.
        class _StopTest(Exception):
            pass

        async def fake_sleep(seconds):
            if call_count >= 2:
                raise _StopTest()

        with (
            patch.object(icy_mod._client, "stream", stream),
            patch.object(icy_mod.asyncio, "sleep", fake_sleep),
        ):
            try:
                await icy_mod.watch("http://station", titles.append)
            except _StopTest:
                pass

        assert call_count == 2
        assert titles == ["Artist - Track", "Artist - Track"]

    async def test_follows_the_redirect_a_load_balancing_station_answers_with(self):
        # A station's published URL is very often a load balancer that 302s
        # to whichever node answers this particular request
        # (rockantenne.de's own hands out s1/s2/s5/s6-webradio.*). This used
        # to raise on the redirect instead of ever reaching the audio, so a
        # working station looked permanently unreachable and said so in the
        # log every five seconds for as long as it played.
        metaint = 8
        chunk = _icy_block(b"a" * metaint, "Artist - Track")

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "balancer":
                return httpx.Response(302, headers={"location": "http://node/stream"})
            return httpx.Response(200, headers={"icy-metaint": str(metaint)}, content=chunk)

        # Built off the real client's own setting rather than hardcoding
        # True — this asserts the module is configured to get through a
        # redirect, not that a client built here happens to be.
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            follow_redirects=icy_mod._client.follow_redirects,
        )
        titles = []
        async with client:
            with patch.object(icy_mod, "_client", client):
                await icy_mod._watch_once("http://balancer/stream", titles.append)

        assert titles == ["Artist - Track"]


class TestWatchFailureHandling:
    """A watch runs for the whole time a station plays, potentially hours,
    and reconnects on every failure — so what it does when a station simply
    can't be reached decides whether the log stays readable."""

    @staticmethod
    def _failing_stream(error: Exception):
        """Stands in for _client.stream(...), which raises at call time —
        before `async with` ever gets to enter anything."""

        def stream(method, url, headers=None):
            raise error

        return stream

    async def _run_until(self, error: Exception, attempts: int) -> list[float]:
        """Lets watch() fail `attempts` times, returning the delay it slept
        for after each. watch() has no other exit condition while a station
        keeps failing, hence the sentinel."""
        delays: list[float] = []

        class _StopTest(Exception):
            pass

        async def fake_sleep(seconds):
            delays.append(seconds)
            if len(delays) >= attempts:
                raise _StopTest()

        with (
            patch.object(icy_mod._client, "stream", self._failing_stream(error)),
            patch.object(icy_mod.asyncio, "sleep", fake_sleep),
        ):
            try:
                await icy_mod.watch("http://station", lambda t: None)
            except _StopTest:
                pass
        return delays

    async def test_logs_a_run_of_identical_failures_once_not_once_per_attempt(self, caplog):
        with caplog.at_level(logging.DEBUG, logger="connect.icy_metadata"):
            await self._run_until(httpx.ConnectError("All connection attempts failed"), 4)

        info = [r for r in caplog.records if r.levelno == logging.INFO]
        assert len(info) == 1
        assert "All connection attempts failed" in info[0].message
        # The repeats aren't thrown away, just demoted out of the way.
        assert len([r for r in caplog.records if r.levelno == logging.DEBUG]) == 3

    async def test_logs_one_line_per_failure_not_the_libraries_own_three(self, caplog):
        # httpx's HTTPStatusError message is three lines (the status, the
        # redirect target, a docs link) - one routine background retry used
        # to take three lines of log.
        error = httpx.HTTPStatusError(
            "Redirect response '302 Found' for url 'http://station'\n"
            "Redirect location: 'http://node'\n"
            "For more information check: https://example.test",
            request=httpx.Request("GET", "http://station"),
            response=httpx.Response(302),
        )
        with caplog.at_level(logging.INFO, logger="connect.icy_metadata"):
            await self._run_until(error, 2)

        assert len(caplog.records) == 1
        assert "\n" not in caplog.records[0].message
        assert "For more information check" not in caplog.records[0].message

    async def test_backs_off_instead_of_reconnecting_every_five_seconds_forever(self):
        delays = await self._run_until(httpx.ConnectError("nope"), 6)
        assert delays == [5.0, 10.0, 20.0, 40.0, 60.0, 60.0]
