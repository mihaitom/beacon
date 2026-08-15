"""Tests for core/radio_stations.py — persistent self-hosted radio stations
(used by the Jellyfin bridge — see media/jellyfin_bridge.py)."""

import tempfile
from pathlib import Path
from unittest.mock import patch

from core import radio_stations


def _tmp_path(tmp_dir: str) -> str:
    return str(Path(tmp_dir) / "test_stations.json")


def test_list_returns_empty_when_no_file():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(radio_stations, "_PATH", _tmp_path(d)):
            assert radio_stations.list_stations() == []


def test_create_and_list_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(radio_stations, "_PATH", _tmp_path(d)):
            station = radio_stations.create("KEXP", "https://stream.kexp.org", "https://kexp.org")
            assert station["name"] == "KEXP"
            assert station["streamUrl"] == "https://stream.kexp.org"
            assert station["homePageUrl"] == "https://kexp.org"
            assert station["id"]

            stations = radio_stations.list_stations()
            assert len(stations) == 1
            assert stations[0] == station


def test_create_generates_unique_ids():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(radio_stations, "_PATH", _tmp_path(d)):
            a = radio_stations.create("A", "https://a.example")
            b = radio_stations.create("B", "https://b.example")
            assert a["id"] != b["id"]


def test_update_existing_station():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(radio_stations, "_PATH", _tmp_path(d)):
            station = radio_stations.create("Old Name", "https://old.example")
            updated = radio_stations.update(
                station["id"], "New Name", "https://new.example", "https://home.example"
            )
            assert updated is True

            stations = radio_stations.list_stations()
            assert stations[0]["name"] == "New Name"
            assert stations[0]["streamUrl"] == "https://new.example"
            assert stations[0]["homePageUrl"] == "https://home.example"
            # id stays stable across an update.
            assert stations[0]["id"] == station["id"]


def test_update_unknown_station_returns_false():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(radio_stations, "_PATH", _tmp_path(d)):
            assert radio_stations.update("no-such-id", "X", "https://x.example") is False


def test_delete_existing_station():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(radio_stations, "_PATH", _tmp_path(d)):
            station = radio_stations.create("Gone Soon", "https://gone.example")
            assert radio_stations.delete(station["id"]) is True
            assert radio_stations.list_stations() == []


def test_delete_unknown_station_returns_false():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(radio_stations, "_PATH", _tmp_path(d)):
            assert radio_stations.delete("no-such-id") is False


def test_delete_only_removes_matching_station():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(radio_stations, "_PATH", _tmp_path(d)):
            keep = radio_stations.create("Keep", "https://keep.example")
            gone = radio_stations.create("Gone", "https://gone.example")
            radio_stations.delete(gone["id"])
            stations = radio_stations.list_stations()
            assert len(stations) == 1
            assert stations[0]["id"] == keep["id"]
