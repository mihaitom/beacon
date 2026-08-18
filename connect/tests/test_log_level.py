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
        *log_level._HTTP_CLIENT_LOGGERS,
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
            os.environ.pop("DEBUG", None)
            assert log_level.initial_level() == "INFO"


def test_initial_level_honors_debug_env_when_nothing_persisted():
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(log_level, "_PATH", _tmp_path(d)),
            patch.dict(os.environ, {"DEBUG": "true"}),
        ):
            assert log_level.initial_level() == "DEBUG"


def test_initial_level_prefers_persisted_over_debug_env():
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(log_level, "_PATH", _tmp_path(d)),
            patch.dict(os.environ, {"DEBUG": "true"}),
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


def test_apply_debug_also_enables_http_client_loggers():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            log_level.apply("DEBUG")
            for name in log_level._HTTP_CLIENT_LOGGERS:
                assert logging.getLogger(name).level == logging.DEBUG
            assert logging.getLogger("uvicorn.access").level == logging.INFO


def test_apply_non_debug_keeps_http_client_loggers_quiet():
    with tempfile.TemporaryDirectory() as d:
        with patch.object(log_level, "_PATH", _tmp_path(d)):
            log_level.apply("ERROR")
            for name in log_level._HTTP_CLIENT_LOGGERS:
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
