"""Tests for credentials.py — persistent AirPlay credential storage."""

import importlib
import json
import os
import tempfile
import threading
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


def test_get_returns_none_on_malformed_json(caplog):
    import logging

    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            f.write("{not valid json")
        with (
            patch.object(credentials, "_PATH", path),
            caplog.at_level(logging.WARNING, logger="connect.credentials"),
        ):
            assert credentials.get("HomePod") is None

    assert "Load failed" in caplog.text


def test_save_logs_but_does_not_raise_when_unwritable(caplog):
    import logging

    with tempfile.TemporaryDirectory() as d:
        # A file, not a directory, as the parent — os.makedirs() on it fails.
        blocker = Path(d) / "blocker"
        blocker.write_text("x")
        path = str(blocker / "nested" / "creds.json")
        with (
            patch.object(credentials, "_PATH", path),
            caplog.at_level(logging.ERROR, logger="connect.credentials"),
        ):
            credentials.save("HomePod", "creds")  # must not raise

    assert "Save failed" in caplog.text


def test_connect_data_dir_env_var_overrides_default_path():
    with tempfile.TemporaryDirectory() as d:
        with patch.dict(os.environ, {"CONNECT_DATA_DIR": d}):
            reloaded = importlib.reload(credentials)
            try:
                assert reloaded._PATH == os.path.join(d, "airplay_credentials.json")
            finally:
                importlib.reload(credentials)  # restore original module state


# ── Durability: this one file holds *every* paired device's credential ───


def test_an_interrupted_write_leaves_the_previous_file_intact(monkeypatch):
    """The real durability property, exercised the way it actually breaks:
    a write that dies partway (crash, full disk). Written into a temp file
    and moved into place with os.replace(), so the live file is either the
    old one or the new one — a truncate-in-place would have emptied it and
    unpaired every speaker along with the failed write."""
    with tempfile.TemporaryDirectory() as d:
        with patch.object(credentials, "_PATH", _tmp_path(d)):
            credentials.save("HomePod", "creds-a")

            def boom(*args, **kwargs):
                raise OSError("No space left on device")

            monkeypatch.setattr(credentials.json, "dump", boom)
            credentials.save("Apple TV", "creds-b")  # must not raise
            monkeypatch.undo()

            assert credentials.get("HomePod") == "creds-a"
            assert not os.path.exists(f"{credentials._PATH}.tmp")


def test_save_does_not_unpair_everything_when_the_store_is_unreadable():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with patch.object(credentials, "_PATH", path):
            credentials.save("HomePod", "creds-a")
            with open(path, "w", encoding="utf-8") as f:
                f.write('{"trunca')  # e.g. a crash mid-write by an older build

            credentials.save("Apple TV", "creds-b")

            # HomePod's credential was in the damaged half either way. What
            # must not happen is losing it *silently*: the unreadable copy
            # is kept for recovery instead of being overwritten.
            assert credentials.get("Apple TV") == "creds-b"
            with open(f"{path}.corrupt", encoding="utf-8") as f:
                assert f.read() == '{"trunca'


def test_concurrent_saves_do_not_lose_each_other():
    """routes/pairing.py can finish one pairing while another request
    unpairs a different speaker, and save()/delete() are read-modify-write
    over a shared file — without the lock the later write would be built on
    a copy read before the earlier one landed."""
    names = [f"Speaker {i}" for i in range(20)]
    barrier = threading.Barrier(len(names))

    with tempfile.TemporaryDirectory() as d:
        with patch.object(credentials, "_PATH", _tmp_path(d)):

            def pair(name: str) -> None:
                barrier.wait()
                credentials.save(name, f"creds-{name}")

            threads = [threading.Thread(target=pair, args=(n,)) for n in names]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            assert sorted(credentials.list_paired()) == sorted(names)
