"""Tests for the individual lyrics providers' own request/parsing logic
(lyrics/lrclib.py, lyrics/netease.py, lyrics/simpmusic.py) — as opposed to
test_lyrics.py, which only exercises routes/lyrics.py's own dispatch against
mocked fetchers. See test_lyrics_live.py for the (opt-in, real-network)
end-to-end equivalent of these same providers."""

from unittest.mock import AsyncMock, patch

import httpx

from lyrics import lrclib, netease, simpmusic

# ── shared test doubles ──────────────────────────────────────────────────────


def _response(url: str, json_body, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=json_body, request=httpx.Request("GET", url))


class _FakeAsyncClient:
    """Stand-in for `async with httpx.AsyncClient(...) as client:` — netease.py
    and simpmusic.py build a fresh client per request rather than sharing a
    module-level one (unlike lrclib.py's `_client`), so patching `.get` on an
    instance doesn't reach them; the class itself has to be replaced."""

    def __init__(self, get_result):
        self._get_result = get_result

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def get(self, *args, **kwargs):
        if isinstance(self._get_result, BaseException):
            raise self._get_result
        return self._get_result


def _patch_async_client(module, get_result):
    return patch.object(module.httpx, "AsyncClient", _FakeAsyncClient(get_result))


# ── lrclib.py ─────────────────────────────────────────────────────────────


async def test_lrclib_get_lyrics_prefers_synced_over_plain():
    body = {"syncedLyrics": "[00:01.00] la la", "plainLyrics": "la la"}
    with patch.object(lrclib, "_client") as client:
        client.get = AsyncMock(return_value=_response(lrclib.FETCH_URL, body))
        result = await lrclib.get_lyrics_by_song_id("123")
    assert result == "[00:01.00] la la"


async def test_lrclib_get_lyrics_falls_back_to_plain_when_unsynced():
    body = {"syncedLyrics": None, "plainLyrics": "la la"}
    with patch.object(lrclib, "_client") as client:
        client.get = AsyncMock(return_value=_response(lrclib.FETCH_URL, body))
        result = await lrclib.get_lyrics_by_song_id("123")
    assert result == "la la"


async def test_lrclib_get_lyrics_returns_none_when_neither_field_present():
    with patch.object(lrclib, "_client") as client:
        client.get = AsyncMock(return_value=_response(lrclib.FETCH_URL, {}))
        result = await lrclib.get_lyrics_by_song_id("123")
    assert result is None


async def test_lrclib_get_lyrics_returns_none_and_logs_on_request_failure(caplog):
    with patch.object(lrclib, "_client") as client:
        client.get = AsyncMock(side_effect=httpx.ConnectError("refused"))
        result = await lrclib.get_lyrics_by_song_id("123")
    assert result is None
    assert "lrclib" in caplog.text


async def test_lrclib_get_lyrics_returns_none_on_http_error_status():
    with patch.object(lrclib, "_client") as client:
        client.get = AsyncMock(return_value=_response(lrclib.FETCH_URL, {}, status=500))
        result = await lrclib.get_lyrics_by_song_id("123")
    assert result is None


async def test_lrclib_get_search_results_returns_none_without_name_or_artist():
    with patch.object(lrclib, "_client") as client:
        result = await lrclib.get_search_results({})
    assert result is None
    client.get.assert_not_called()


async def test_lrclib_get_search_results_maps_and_ranks_songs():
    songs = [
        {
            "artistName": "The Artist",
            "id": 42,
            "name": "Exact Song",
            "syncedLyrics": "[00:01.00] x",
            "duration": 180,
        }
    ]
    with patch.object(lrclib, "_client") as client:
        client.get = AsyncMock(return_value=_response(lrclib.SEARCH_URL, songs))
        result = await lrclib.get_search_results({"name": "Exact Song", "artist": "The Artist"})

    assert result[0] == {
        "artist": "The Artist",
        "id": "42",
        "isSync": True,
        "name": "Exact Song",
        "source": "lrclib.net",
        "duration": 180,
        "score": 0.0,
    }


async def test_lrclib_get_search_results_returns_none_when_response_is_not_a_list():
    with patch.object(lrclib, "_client") as client:
        client.get = AsyncMock(return_value=_response(lrclib.SEARCH_URL, {"error": "nope"}))
        result = await lrclib.get_search_results({"name": "x"})
    assert result is None


async def test_lrclib_get_search_results_returns_none_and_logs_on_request_failure(caplog):
    with patch.object(lrclib, "_client") as client:
        client.get = AsyncMock(side_effect=httpx.ConnectError("refused"))
        result = await lrclib.get_search_results({"name": "x"})
    assert result is None
    assert "lrclib" in caplog.text


# ── netease.py ────────────────────────────────────────────────────────────


async def test_netease_get_lyrics_extracts_lrc_lyric():
    body = {"lrc": {"lyric": "[00:01.00] la la"}}
    with _patch_async_client(netease, _response(netease.LYRICS_URL, body)):
        result = await netease.get_lyrics_by_song_id("123")
    assert result == "[00:01.00] la la"


async def test_netease_get_lyrics_returns_none_when_lrc_is_explicitly_null():
    # NetEase returns "lrc": null (not an absent key) for songs with no
    # lyrics — `.get("lrc") or {}` guards against that reaching
    # `.get("lyric")` on a bare None and raising AttributeError.
    body = {"lrc": None}
    with _patch_async_client(netease, _response(netease.LYRICS_URL, body)):
        result = await netease.get_lyrics_by_song_id("123")
    assert result is None


async def test_netease_get_lyrics_returns_none_when_lrc_key_missing_entirely():
    with _patch_async_client(netease, _response(netease.LYRICS_URL, {})):
        result = await netease.get_lyrics_by_song_id("123")
    assert result is None


async def test_netease_get_lyrics_returns_none_and_logs_on_request_failure(caplog):
    with _patch_async_client(netease, httpx.ConnectError("refused")):
        result = await netease.get_lyrics_by_song_id("123")
    assert result is None
    assert "netease" in caplog.text


async def test_netease_get_search_results_returns_none_without_name_or_artist():
    with _patch_async_client(netease, _response(netease.SEARCH_URL, {})) as _:
        result = await netease.get_search_results({})
    assert result is None


async def test_netease_get_search_results_maps_songs_and_converts_duration_to_seconds():
    body = {
        "result": {
            "songs": [
                {
                    "artists": [{"name": "A"}, {"name": "B"}],
                    "id": 7,
                    "name": "Song",
                    "duration": 4500,
                }
            ]
        }
    }
    with _patch_async_client(netease, _response(netease.SEARCH_URL, body)):
        result = await netease.get_search_results({"name": "Song"})

    assert result[0]["artist"] == "A, B"
    assert result[0]["id"] == "7"
    assert result[0]["source"] == "NetEase"
    assert result[0]["duration"] == 4.5


async def test_netease_get_search_results_handles_missing_duration():
    body = {"result": {"songs": [{"artists": [], "id": 1, "name": "Song"}]}}
    with _patch_async_client(netease, _response(netease.SEARCH_URL, body)):
        result = await netease.get_search_results({"name": "Song"})
    assert result[0]["duration"] is None


async def test_netease_get_search_results_returns_none_when_no_songs_found():
    body = {"result": {}}
    with _patch_async_client(netease, _response(netease.SEARCH_URL, body)):
        result = await netease.get_search_results({"name": "Song"})
    assert result is None


async def test_netease_get_search_results_returns_none_and_logs_on_request_failure(caplog):
    with _patch_async_client(netease, httpx.ConnectError("refused")):
        result = await netease.get_search_results({"name": "Song"})
    assert result is None
    assert "netease" in caplog.text


# ── simpmusic.py ──────────────────────────────────────────────────────────


async def test_simpmusic_get_lyrics_prefers_synced_over_plain():
    body = {"data": [{"syncedLyrics": "[00:01.00] la la", "plainLyric": "la la"}]}
    with _patch_async_client(simpmusic, _response(simpmusic.API_URL, body)):
        result = await simpmusic.get_lyrics_by_song_id("abc")
    assert result == "[00:01.00] la la"


async def test_simpmusic_get_lyrics_falls_back_to_plain_lyric():
    body = {"data": [{"syncedLyrics": None, "plainLyric": "la la"}]}
    with _patch_async_client(simpmusic, _response(simpmusic.API_URL, body)):
        result = await simpmusic.get_lyrics_by_song_id("abc")
    assert result == "la la"


async def test_simpmusic_get_lyrics_returns_none_when_data_is_empty():
    with _patch_async_client(simpmusic, _response(simpmusic.API_URL, {"data": []})):
        result = await simpmusic.get_lyrics_by_song_id("abc")
    assert result is None


async def test_simpmusic_get_lyrics_returns_none_when_data_key_missing():
    with _patch_async_client(simpmusic, _response(simpmusic.API_URL, {})):
        result = await simpmusic.get_lyrics_by_song_id("abc")
    assert result is None


async def test_simpmusic_get_lyrics_returns_none_and_logs_on_request_failure(caplog):
    with _patch_async_client(simpmusic, httpx.ConnectError("refused")):
        result = await simpmusic.get_lyrics_by_song_id("abc")
    assert result is None
    assert "simpmusic" in caplog.text


async def test_simpmusic_get_search_results_returns_none_without_name():
    result = await simpmusic.get_search_results({})
    assert result is None


async def test_simpmusic_get_search_results_maps_songs():
    body = {
        "data": [
            {
                "artistName": "The Artist",
                "videoId": "vid1",
                "songTitle": "Song",
                "syncedLyrics": True,
                "durationSeconds": 210,
            }
        ]
    }
    with _patch_async_client(simpmusic, _response(f"{simpmusic.API_URL}/search", body)):
        result = await simpmusic.get_search_results({"name": "Song"})

    assert result[0] == {
        "artist": "The Artist",
        "id": "vid1",
        "isSync": True,
        "name": "Song",
        "source": "SimpMusic",
        "duration": 210,
        "score": 0.0,
    }


async def test_simpmusic_get_search_results_returns_none_when_no_songs():
    with _patch_async_client(simpmusic, _response(f"{simpmusic.API_URL}/search", {"data": None})):
        result = await simpmusic.get_search_results({"name": "Song"})
    assert result is None


async def test_simpmusic_get_search_results_returns_none_and_logs_on_request_failure(caplog):
    with _patch_async_client(simpmusic, httpx.ConnectError("refused")):
        result = await simpmusic.get_search_results({"name": "Song"})
    assert result is None
    assert "simpmusic" in caplog.text
