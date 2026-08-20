"""Tests for core/log_level.py and routes/log_level.py — the Settings
log-level dropdown's persisted runtime verbosity."""

import logging
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from core import log_level


def _tmp_path(tmp_dir: str) -> str:
    return str(Path(tmp_dir) / "test_log_level.txt")


@pytest.fixture(autouse=True)
def _restore_levels():
    """apply() mutates real, process-wide logger objects — restore whatever
    every test touches back to its pre-test level afterward so tests don't
    leak verbosity into each other (or into unrelated tests running later
    in the same process)."""
    loggers = [
        *log_level._APP_LOGGERS,
        *log_level._THIRD_PARTY_LOGGERS,
        "uvicorn.access",
    ]
    before = {name: logging.getLogger(name).level for name in loggers}
    yield
    for name, lvl in before.items():
        logging.getLogger(name).setLevel(lvl)


def test_initial_level_defaults_to_info():
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(log_level, "_PATH", _tmp_path(d)),
            patch.dict(os.environ, {}, clear=False),
        ):
            os.environ.pop("LOG_LEVEL", None)
            assert log_level.initial_level() == "INFO"


def test_initial_level_honors_log_level_env_when_nothing_persisted():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            # Case-insensitive — LEVELS itself is always upper-case.
            with patch.dict(os.environ, {"LOG_LEVEL": "trace"}):
                assert log_level.initial_level() == "TRACE"


def test_initial_level_ignores_invalid_log_level_env():
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(log_level, "_PATH", _tmp_path(d)),
            patch.dict(os.environ, {"LOG_LEVEL": "VERBOSE"}),
        ):
            assert log_level.initial_level() == "INFO"


def test_initial_level_prefers_persisted_over_log_level_env():
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(log_level, "_PATH", _tmp_path(d)),
            patch.dict(os.environ, {"LOG_LEVEL": "TRACE"}),
        ):
            log_level.apply("WARNING")
            assert log_level.initial_level() == "WARNING"


def test_apply_persists_by_default():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            log_level.apply("ERROR")
            assert log_level._load_persisted() == "ERROR"


def test_apply_does_not_persist_when_disabled():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            log_level.apply("DEBUG", persist=False)
            assert log_level._load_persisted() is None


def test_apply_sets_app_loggers_and_current_level_reflects_it():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            log_level.apply("WARNING")
            for name in log_level._APP_LOGGERS:
                assert logging.getLogger(name).level == logging.WARNING
            assert log_level.current_level() == "WARNING"


def test_apply_trace_current_level_roundtrips_through_custom_level_name():
    """TRACE is a custom level registered via addLevelName() at import time
    — this is really a check that logging.getLevelName() actually resolves
    the numeric value (5) back to "TRACE" rather than the "Level 5" fallback
    it'd print for an unregistered custom level."""
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            log_level.apply("TRACE")
            assert log_level.current_level() == "TRACE"


def test_apply_trace_also_enables_third_party_loggers():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            log_level.apply("TRACE")
            for name in log_level._APP_LOGGERS:
                assert logging.getLogger(name).level == log_level.TRACE
            for name in log_level._THIRD_PARTY_LOGGERS:
                assert logging.getLogger(name).level == log_level.TRACE
            assert logging.getLogger("uvicorn.access").level == logging.INFO


def test_apply_debug_keeps_third_party_loggers_quiet():
    """The behavior TRACE exists for — DEBUG alone (our own code's detail)
    must *not* also turn on every SOAP/HTTP request the libraries
    underneath make, unlike before TRACE existed."""
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            log_level.apply("DEBUG")
            for name in log_level._APP_LOGGERS:
                assert logging.getLogger(name).level == logging.DEBUG
            for name in log_level._THIRD_PARTY_LOGGERS:
                assert logging.getLogger(name).level == logging.WARNING
            assert logging.getLogger("uvicorn.access").level == logging.WARNING


def test_apply_non_debug_keeps_third_party_loggers_quiet():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            log_level.apply("ERROR")
            for name in log_level._THIRD_PARTY_LOGGERS:
                assert logging.getLogger(name).level == logging.WARNING
            assert logging.getLogger("uvicorn.access").level == logging.WARNING


def test_apply_rejects_invalid_level():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            with pytest.raises(ValueError):
                log_level.apply("VERBOSE")


def test_load_persisted_ignores_garbage_file():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            f.write("not-a-level")
        with patch.object(log_level, "_PATH", path):
            assert log_level._load_persisted() is None


def test_load_persisted_returns_none_and_logs_on_unexpected_error(caplog):
    with (
        patch.object(log_level, "_PATH", "/dev/null/not-a-real-path"),
        caplog.at_level(logging.WARNING, logger="connect.log_level"),
    ):
        assert log_level._load_persisted() is None

    assert "Load failed" in caplog.text


def test_save_persisted_logs_but_does_not_raise_when_unwritable(caplog):
    with tempfile.TemporaryDirectory() as d:
        # A file, not a directory, as the parent — os.makedirs() on it fails.
        blocker = Path(d) / "blocker"
        blocker.write_text("x")
        path = str(blocker / "nested" / "log_level.txt")
        with (
            patch.object(log_level, "_PATH", path),
            caplog.at_level(logging.ERROR, logger="connect.log_level"),
        ):
            log_level._save_persisted("DEBUG")  # must not raise

    assert "Save failed" in caplog.text


def test_get_and_post_log_level_roundtrip(client):
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            r = client.post("/log-level", json={"level": "debug"})
            assert r.status_code == 200
            assert r.json()["level"] == "DEBUG"

            r = client.get("/log-level")
            assert r.status_code == 200
            body = r.json()
            assert body["level"] == "DEBUG"
            assert set(body["levels"]) == set(log_level.LEVELS)


def test_post_log_level_rejects_invalid_value(client):
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            r = client.post("/log-level", json={"level": "VERBOSE"})
            assert r.status_code == 422
