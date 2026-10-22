"""Tests for core/older_sonos.py and routes/older_sonos.py — how the older
Sonos models get a song, Settings → Advanced's choice (#56). conftest.py
points the file at a fresh temporary path per test."""

import pytest

from core import older_sonos


def test_older_models_get_the_whole_song_at_once_until_told_otherwise():
    assert older_sonos.stream_mode() == "whole"


@pytest.mark.parametrize("mode", ["paced", "file", "whole"])
def test_the_mode_survives_a_restart(mode):
    older_sonos.set_stream_mode(mode)
    older_sonos._mode = None  # what a fresh process starts with

    assert older_sonos.stream_mode() == mode


def test_a_damaged_file_falls_back_to_the_default(tmp_path):
    with open(older_sonos._PATH, "w", encoding="utf-8") as f:
        f.write("sideways")

    assert older_sonos.stream_mode() == "whole"


def test_the_route_reads_and_writes_the_mode(client):
    assert client.get("/older-sonos").json() == {
        "mode": "whole",
        "modes": ["whole", "paced", "file"],
    }

    assert client.post("/older-sonos", json={"mode": "file"}).json() == {"mode": "file"}

    assert client.get("/older-sonos").json()["mode"] == "file"
    assert older_sonos.stream_mode() == "file"


def test_the_route_rejects_a_mode_it_does_not_know(client):
    assert client.post("/older-sonos", json={"mode": "sideways"}).status_code == 422
    assert older_sonos.stream_mode() == "whole"
