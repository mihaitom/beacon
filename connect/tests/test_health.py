"""Tests for GET /health."""

from unittest.mock import patch


def test_ffmpeg_found(client):
    with patch("shutil.which", return_value="/usr/bin/ffmpeg"):
        r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ffmpeg"] is True


def test_ffmpeg_missing(client):
    with patch("shutil.which", return_value=None):
        r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ffmpeg"] is False


def test_navidrome_not_configured(client):
    r = client.get("/health")
    assert r.json()["navidrome_configured"] is False


def test_navidrome_configured(client):
    client.post("/config", json={"url": "http://nav:4533", "credential": "token=x"})
    r = client.get("/health")
    assert r.json()["navidrome_configured"] is True
