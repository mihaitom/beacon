"""Tests for core/radio_station_info.py and its route, /radio-station-info."""

from unittest.mock import AsyncMock, patch

import pytest

from core import radio_history, radio_station_info
from core.session import DEFAULT_SESSION_ID


def _station(uuid: str = "u1", **overrides) -> dict:
    station = {
        "stationuuid": uuid,
        "name": "Example FM",
        "tags": "pop,rock",
        "country": "Germany",
        "codec": "MP3",
        "bitrate": 128,
        "votes": 10,
    }
    station.update(overrides)
    return station


@pytest.fixture
def directory():
    """Radio Browser, stubbed: by_uuid and by_url are AsyncMocks a test
    sets answers on."""
    with (
        patch.object(
            radio_station_info.radio_browser, "stations_by_uuid", new=AsyncMock(return_value=[])
        ) as by_uuid,
        patch.object(
            radio_station_info.radio_browser, "stations_by_url", new=AsyncMock(return_value=[])
        ) as by_url,
    ):
        yield by_uuid, by_url


class TestCleanTags:
    def test_keeps_the_first_few_distinct_tags(self):
        tags = radio_station_info.clean_tags("pop, Rock,rock,,indie,talk,news", "")

        assert tags == ["pop", "Rock", "indie"]

    def test_leaves_out_the_country_which_is_shown_on_its_own(self):
        assert radio_station_info.clean_tags("germany,pop", "Germany") == ["pop"]


class TestDirectoryDetails:
    async def test_looks_up_every_known_id_in_one_request(self, directory):
        by_uuid, by_url = directory
        by_uuid.return_value = [_station("u1"), _station("u2", tags="jazz")]

        details = await radio_station_info.directory_details(
            [("http://a", "u1"), ("http://b", "u2")]
        )

        by_uuid.assert_awaited_once_with(["u1", "u2"])
        by_url.assert_not_awaited()
        assert details["http://b"] == {
            "tags": ["jazz"],
            "country": "Germany",
            "codec": "MP3",
            "bitrate": 128,
        }

    async def test_looks_a_station_without_an_id_up_by_its_url(self, directory):
        _, by_url = directory
        by_url.return_value = [_station(votes=1, tags="old"), _station(votes=50, tags="kept")]

        details = await radio_station_info.directory_details([("http://a", None)])

        by_url.assert_awaited_once_with("http://a")
        assert details["http://a"]["tags"] == ["kept"]

    async def test_an_unknown_codec_is_left_blank_rather_than_shown(self, directory):
        _, by_url = directory
        by_url.return_value = [_station(codec="UNKNOWN", bitrate=0)]

        details = await radio_station_info.directory_details([("http://a", None)])

        assert details["http://a"]["codec"] == ""
        assert details["http://a"]["bitrate"] is None

    async def test_answers_a_second_time_from_its_cache(self, directory):
        _, by_url = directory
        by_url.return_value = [_station()]
        await radio_station_info.directory_details([("http://a", None)])

        radio_station_info._cache = None  # as after a restart: read back from disk
        details = await radio_station_info.directory_details([("http://a", None)])

        assert by_url.await_count == 1
        assert details["http://a"]["tags"] == ["pop", "rock"]

    async def test_asks_again_once_the_answer_is_old(self, directory):
        _, by_url = directory
        by_url.return_value = [_station()]
        await radio_station_info.directory_details([("http://a", None)])

        later = radio_station_info.time.time() + radio_station_info._FOUND_TTL + 1
        with patch.object(radio_station_info.time, "time", return_value=later):
            await radio_station_info.directory_details([("http://a", None)])

        assert by_url.await_count == 2

    async def test_remembers_a_station_the_directory_does_not_know_for_less_long(self, directory):
        _, by_url = directory
        await radio_station_info.directory_details([("http://a", None)])
        await radio_station_info.directory_details([("http://a", None)])
        assert by_url.await_count == 1

        later = radio_station_info.time.time() + radio_station_info._MISSING_TTL + 1
        with patch.object(radio_station_info.time, "time", return_value=later):
            details = await radio_station_info.directory_details([("http://a", None)])

        assert by_url.await_count == 2
        assert details["http://a"] is None

    async def test_does_not_remember_a_lookup_that_failed(self, directory):
        by_uuid, by_url = directory
        by_uuid.return_value = None
        by_url.return_value = None

        details = await radio_station_info.directory_details(
            [("http://a", "u1"), ("http://b", None)]
        )
        await radio_station_info.directory_details([("http://a", "u1"), ("http://b", None)])

        assert details == {}
        assert by_uuid.await_count == 2
        assert by_url.await_count == 2


class TestLastTitle:
    def _log(self, url: str, *titles: str) -> None:
        for i, title in enumerate(titles):
            radio_history.append(
                DEFAULT_SESSION_ID, url, {"title": title, "at": 1000.0 + i}, max_entries=100
            )

    async def test_is_the_newest_title_heard_on_the_station(self):
        self._log("http://a", "Old - Song", "New - Song")

        title = await radio_station_info.last_title(DEFAULT_SESSION_ID, "http://a")

        assert title == {"title": "New - Song", "at": 1001.0}

    async def test_passes_over_an_advert(self):
        self._log("http://a", "Real - Song", "example.com - Buy now")

        title = await radio_station_info.last_title(DEFAULT_SESSION_ID, "http://a")

        assert title["title"] == "Real - Song"

    async def test_finds_a_playlist_station_under_the_stream_it_resolved_to(self):
        self._log("http://cdn/stream", "Some - Song")

        with patch.object(
            radio_station_info,
            "resolve_stream_url",
            new=AsyncMock(return_value="http://cdn/stream"),
        ):
            title = await radio_station_info.last_title(DEFAULT_SESSION_ID, "http://a/live.m3u")

        assert title["title"] == "Some - Song"

    async def test_is_none_for_a_station_never_heard(self):
        assert await radio_station_info.last_title(DEFAULT_SESSION_ID, "http://a") is None


def test_route_combines_both_per_station(client, default_session, directory):
    by_uuid, _ = directory
    by_uuid.return_value = [_station("u1")]
    radio_history.append(
        DEFAULT_SESSION_ID, "http://a", {"title": "A - B", "at": 5.0}, max_entries=100
    )

    r = client.post(
        "/radio-station-info",
        json={"stations": [{"url": "http://a", "uuid": "u1"}, {"url": "http://b"}]},
    )

    assert r.status_code == 200
    assert r.json()["stations"] == {
        "http://a": {
            "tags": ["pop", "rock"],
            "country": "Germany",
            "codec": "MP3",
            "bitrate": 128,
            "lastTitle": {"title": "A - B", "at": 5.0},
        },
        "http://b": {"lastTitle": None},
    }
