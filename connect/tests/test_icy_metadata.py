"""Tests for core/icy_metadata.py — reading a radio stream's ICY
"now playing" tag."""

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
