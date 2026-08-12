"""Tests for credentials.py — persistent AirPlay credential storage."""

import importlib
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

from delivery import credentials


def _tmp_path(tmp_dir: str) -> str:
    return str(Path(tmp_dir) / "test_creds.json")


def test_get_returns_none_when_no_file():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(credentials, "_PATH", _tmp_path(d)):
            assert credentials.get("HomePod") is None


def test_save_and_get_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(credentials, "_PATH", _tmp_path(d)):
            credentials.save("HomePod", "abc123")
            assert credentials.get("HomePod") == "abc123"


def test_save_overwrites_existing():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(credentials, "_PATH", _tmp_path(d)):
            credentials.save("HomePod", "old")
            credentials.save("HomePod", "new")
            assert credentials.get("HomePod") == "new"


def test_multiple_devices():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(credentials, "_PATH", _tmp_path(d)):
            credentials.save("HomePod", "creds-a")
            credentials.save("Apple TV", "creds-b")
            assert credentials.get("HomePod") == "creds-a"
            assert credentials.get("Apple TV") == "creds-b"
            assert credentials.get("Unknown") is None


def test_list_paired_empty():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(credentials, "_PATH", _tmp_path(d)):
            assert credentials.list_paired() == []


def test_list_paired_returns_names():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(credentials, "_PATH", _tmp_path(d)):
            credentials.save("HomePod", "x")
            credentials.save("Apple TV", "y")
            result = credentials.list_paired()
            assert set(result) == {"HomePod", "Apple TV"}


def test_delete_existing():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(credentials, "_PATH", _tmp_path(d)):
            credentials.save("HomePod", "x")
            assert credentials.delete("HomePod") is True
            assert credentials.get("HomePod") is None


def test_delete_nonexistent_returns_false():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(credentials, "_PATH", _tmp_path(d)):
            assert credentials.delete("HomePod") is False


def test_delete_leaves_other_devices():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(credentials, "_PATH", _tmp_path(d)):
            credentials.save("HomePod", "a")
            credentials.save("Apple TV", "b")
            credentials.delete("HomePod")
            assert credentials.get("Apple TV") == "b"
            assert credentials.get("HomePod") is None


def test_persists_as_valid_json():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with patch.object(credentials, "_PATH", path):
            credentials.save("HomePod", "creds")
        with open(path) as f:
            data = json.load(f)
        assert data == {"HomePod": "creds"}


def test_save_creates_missing_data_dir():
    """CONNECT_DATA_DIR may point at a directory the Electron app hasn't
    created yet (first launch) — saving must not fail because of that."""
    with tempfile.TemporaryDirectory() as d:
        nested = os.path.join(d, "not-yet-created")
        with patch.object(credentials, "_PATH", os.path.join(nested, "creds.json")):
            credentials.save("HomePod", "creds")
            assert credentials.get("HomePod") == "creds"


def test_connect_data_dir_env_var_overrides_default_path():
    with tempfile.TemporaryDirectory() as d:
        with patch.dict(os.environ, {"CONNECT_DATA_DIR": d}):
            reloaded = importlib.reload(credentials)
            try:
                assert reloaded._PATH == os.path.join(d, "airplay_credentials.json")
            finally:
                importlib.reload(credentials)  # restore original module state
