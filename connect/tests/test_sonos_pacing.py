"""Tests for core/sonos_pacing.py and routes/sonos_pacing.py — Settings'
switch that sends the older Sonos models their stream at playback speed
(#56). conftest.py points the file at a fresh temporary path per test."""

from core import sonos_pacing


def test_older_models_are_unpaced_until_switched():
    assert sonos_pacing.old_models_paced() is False


def test_the_switch_survives_a_restart():
    sonos_pacing.set_old_models_paced(True)
    sonos_pacing._paced = None  # what a fresh process starts with

    assert sonos_pacing.old_models_paced() is True

    sonos_pacing.set_old_models_paced(False)
    sonos_pacing._paced = None

    assert sonos_pacing.old_models_paced() is False


def test_the_route_reads_and_writes_the_switch(client):
    assert client.get("/sonos-pacing").json() == {"paced": False}

    assert client.post("/sonos-pacing", json={"paced": True}).json() == {"paced": True}

    assert client.get("/sonos-pacing").json() == {"paced": True}
    assert sonos_pacing.old_models_paced() is True


def test_the_route_rejects_anything_but_a_boolean(client):
    assert client.post("/sonos-pacing", json={"paced": "sometimes"}).status_code == 422
