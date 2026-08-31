"""Tests for core/radio_browser.py — Radio Browser station search."""

import socket
import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from core import radio_browser


@pytest.fixture(autouse=True)
def _clear_server_cache():
    radio_browser._cached_servers = []
    radio_browser._cached_servers_at = 0.0
    radio_browser._cached_countries = None
    radio_browser._cached_countries_at = 0.0
    yield
    radio_browser._cached_servers = []
    radio_browser._cached_servers_at = 0.0
    radio_browser._cached_countries = None
    radio_browser._cached_countries_at = 0.0


def _raw_station(**overrides) -> dict:
    station = {
        "stationuuid": "abc-123",
        "name": "Example FM",
        "url": "http://example.com/stream",
        "url_resolved": "http://example.com/stream-resolved",
        "homepage": "https://example.com",
        "favicon": "https://example.com/favicon.ico",
        "country": "Germany",
        "state": "Bavaria",
        "languagecodes": "en,de",
        "tags": "pop,rock",
        "codec": "MP3",
        "bitrate": 128,
        "votes": 42,
        "clickcount": 7,
        "clicktrend": -2,
        "lastcheckok": 1,
    }
    station.update(overrides)
    return station


def _search_response(stations: list[dict]) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json = MagicMock(return_value=stations)
    return resp


class TestDiscoverServers:
    async def test_resolves_and_reverse_resolves_every_ip(self):
        with (
            patch.object(socket, "gethostbyname_ex", return_value=("x", [], ["1.1.1.1"])),
            patch.object(
                socket, "gethostbyaddr", return_value=("de1.api.radio-browser.info", [], [])
            ),
        ):
            servers = await radio_browser._discover_servers()

        assert servers == ["de1.api.radio-browser.info"]

    async def test_skips_an_ip_with_no_reverse_dns_entry(self):
        with (
            patch.object(
                socket, "gethostbyname_ex", return_value=("x", [], ["1.1.1.1", "2.2.2.2"])
            ),
            patch.object(
                socket,
                "gethostbyaddr",
                side_effect=[socket.herror("no ptr"), ("de2.api.radio-browser.info", [], [])],
            ),
        ):
            servers = await radio_browser._discover_servers()

        assert servers == ["de2.api.radio-browser.info"]

    async def test_caches_within_the_ttl(self):
        with (
            patch.object(socket, "gethostbyname_ex", return_value=("x", [], ["1.1.1.1"])) as dns,
            patch.object(
                socket, "gethostbyaddr", return_value=("de1.api.radio-browser.info", [], [])
            ),
        ):
            await radio_browser._discover_servers()
            await radio_browser._discover_servers()

        dns.assert_called_once()

    async def test_falls_back_to_the_stale_cache_when_a_later_lookup_fails(self):
        with (
            patch.object(socket, "gethostbyname_ex", return_value=("x", [], ["1.1.1.1"])),
            patch.object(
                socket, "gethostbyaddr", return_value=("de1.api.radio-browser.info", [], [])
            ),
        ):
            first = await radio_browser._discover_servers()
        radio_browser._cached_servers_at = 0.0  # force the TTL to have expired

        with patch.object(socket, "gethostbyname_ex", side_effect=socket.gaierror("dns down")):
            second = await radio_browser._discover_servers()

        assert second == first

    async def test_returns_empty_when_nothing_is_cached_and_lookup_fails(self):
        with patch.object(socket, "gethostbyname_ex", side_effect=socket.gaierror("dns down")):
            servers = await radio_browser._discover_servers()

        assert servers == []


class TestSearchStations:
    async def test_returns_none_when_no_server_could_be_discovered(self):
        with patch.object(socket, "gethostbyname_ex", side_effect=socket.gaierror("dns down")):
            result = await radio_browser.search_stations("jazz")

        assert result is None

    async def test_maps_and_prefers_the_resolved_url(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(return_value=_search_response([_raw_station()]))
            result = await radio_browser.search_stations("example")

        assert result == [
            {
                "stationuuid": "abc-123",
                "name": "Example FM",
                "url": "http://example.com/stream-resolved",
                "homepage": "https://example.com",
                "favicon": "https://example.com/favicon.ico",
                "country": "Germany",
                "state": "Bavaria",
                "languagecodes": "en,de",
                "tags": "pop,rock",
                "codec": "MP3",
                "bitrate": 128,
                "votes": 42,
                "clickcount": 7,
                "clicktrend": -2,
                "lastcheckok": True,
            }
        ]
        called_url = client.get.call_args.args[0]
        assert called_url == "https://de1.api.radio-browser.info/json/stations/search"
        assert client.get.call_args.kwargs["params"]["name"] == "example"

    async def test_falls_back_to_the_raw_url_when_nothing_was_resolved(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(return_value=_search_response([_raw_station(url_resolved="")]))
            result = await radio_browser.search_stations("example")

        assert result[0]["url"] == "http://example.com/stream"

    async def test_drops_a_station_with_no_usable_url_at_all(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(
                return_value=_search_response([_raw_station(url="", url_resolved="")])
            )
            result = await radio_browser.search_stations("example")

        assert result == []

    async def test_tries_the_next_server_when_the_first_is_unreachable(self):
        radio_browser._cached_servers = ["dead.example", "de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(
                side_effect=[httpx.ConnectError("down"), _search_response([_raw_station()])]
            )
            result = await radio_browser.search_stations("example")

        assert len(result) == 1
        assert client.get.call_count == 2

    async def test_returns_none_when_every_server_fails(self):
        radio_browser._cached_servers = ["dead1.example", "dead2.example"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(side_effect=httpx.ConnectError("down"))
            result = await radio_browser.search_stations("example")

        assert result is None

    async def test_browses_with_no_name_at_all_when_none_is_given(self):
        # The dialog's initial "top stations" view before anyone has typed
        # anything — see search_stations()'s own docstring for why this is
        # a real, intended call shape rather than something to special-case
        # away in the route.
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(return_value=_search_response([_raw_station()]))
            await radio_browser.search_stations()

        assert "name" not in client.get.call_args.kwargs["params"]

    async def test_passes_a_single_country_filter_through(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(return_value=_search_response([_raw_station()]))
            await radio_browser.search_stations(countrycodes=["DE"])

        params = client.get.call_args.kwargs["params"]
        assert params["countrycode"] == "DE"
        assert "name" not in params

    async def test_fans_out_one_request_per_country_and_merges_by_votes(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        de_station = _raw_station(stationuuid="de-1", name="DE Station", votes=10)
        fr_station = _raw_station(stationuuid="fr-1", name="FR Station", votes=99)

        async def fake_get(url, params=None):
            if params["countrycode"] == "DE":
                return _search_response([de_station])
            return _search_response([fr_station])

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(side_effect=fake_get)
            result = await radio_browser.search_stations(countrycodes=["DE", "FR"])

        assert client.get.call_count == 2
        assert [s["stationuuid"] for s in result] == ["fr-1", "de-1"]  # ranked by votes

    async def test_deduplicates_a_station_shared_across_selected_countries(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()
        shared = _raw_station()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(return_value=_search_response([shared]))
            result = await radio_browser.search_stations(countrycodes=["DE", "FR"])

        assert len(result) == 1

    async def test_multi_country_search_survives_one_country_failing(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        async def fake_get(url, params=None):
            if params["countrycode"] == "DE":
                raise httpx.ConnectError("down")
            return _search_response([_raw_station()])

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(side_effect=fake_get)
            result = await radio_browser.search_stations(countrycodes=["DE", "FR"])

        assert len(result) == 1

    async def test_multi_country_search_returns_none_when_every_country_fails(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(side_effect=httpx.ConnectError("down"))
            result = await radio_browser.search_stations(countrycodes=["DE", "FR"])

        assert result is None

    async def test_accepts_clickcount_as_an_order(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(return_value=_search_response([_raw_station()]))
            await radio_browser.search_stations(order="clickcount")

        params = client.get.call_args.kwargs["params"]
        assert params["order"] == "clickcount"
        assert params["reverse"] == "true"

    async def test_falls_back_to_votes_for_an_unrecognized_order(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(return_value=_search_response([_raw_station()]))
            await radio_browser.search_stations(order="name")

        assert client.get.call_args.kwargs["params"]["order"] == "votes"


class TestRegisterClick:
    async def test_hits_the_first_server_s_click_endpoint(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(return_value=MagicMock())
            await radio_browser.register_click("abc-123")

        client.get.assert_called_once_with("https://de1.api.radio-browser.info/json/url/abc-123")

    async def test_is_a_silent_no_op_when_no_server_is_available(self):
        with patch.object(socket, "gethostbyname_ex", side_effect=socket.gaierror("dns down")):
            await radio_browser.register_click("abc-123")  # must not raise

    async def test_swallows_a_request_failure(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(side_effect=httpx.ConnectError("down"))
            await radio_browser.register_click("abc-123")  # must not raise


def _list_response(entries: list[dict]) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json = MagicMock(return_value=entries)
    return resp


class TestListCountries:
    async def test_filters_out_entries_with_no_stations_and_sorts_by_name(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()
        raw = [
            {"name": "Germany", "iso_3166_1": "DE", "stationcount": 500},
            {"name": "Atlantis", "iso_3166_1": "AT", "stationcount": 0},
            {"name": "Austria", "iso_3166_1": "AT", "stationcount": 50},
        ]

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(return_value=_list_response(raw))
            result = await radio_browser.list_countries()

        assert result == [
            {"name": "Austria", "code": "AT"},
            {"name": "Germany", "code": "DE"},
        ]
        called_url = client.get.call_args.args[0]
        assert called_url == "https://de1.api.radio-browser.info/json/countries"

    async def test_caches_within_the_ttl(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(
                return_value=_list_response(
                    [{"name": "Germany", "iso_3166_1": "DE", "stationcount": 1}]
                )
            )
            await radio_browser.list_countries()
            await radio_browser.list_countries()

        client.get.assert_called_once()

    async def test_falls_back_to_stale_cache_when_every_server_fails(self):
        radio_browser._cached_servers = ["de1.api.radio-browser.info"]
        radio_browser._cached_servers_at = time.monotonic()
        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(
                return_value=_list_response(
                    [{"name": "Germany", "iso_3166_1": "DE", "stationcount": 1}]
                )
            )
            first = await radio_browser.list_countries()
        radio_browser._cached_countries_at = 0.0  # force the TTL to have expired

        with patch.object(radio_browser, "_client") as client:
            client.get = AsyncMock(side_effect=httpx.ConnectError("down"))
            second = await radio_browser.list_countries()

        assert second == first

    async def test_returns_none_when_nothing_is_cached_and_every_server_fails(self):
        with patch.object(socket, "gethostbyname_ex", side_effect=socket.gaierror("dns down")):
            result = await radio_browser.list_countries()

        assert result is None
