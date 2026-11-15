"""Tests for token-based auth (core/auth.py + require_token dependency)."""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from core import auth
from main import app


@pytest.fixture
def unauthed():
    """TestClient with no auth credentials."""
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture
def wrong_token():
    """TestClient with an incorrect token."""
    with TestClient(app, raise_server_exceptions=False) as c:
        c.headers["X-Connect-Token"] = "definitely-wrong-token"
        yield c


# ── Open endpoints (no token required) ───────────────────────────────────────


def test_stream_head_is_open(unauthed):
    assert unauthed.head("/stream").status_code == 200


def test_stream_get_is_open(unauthed):
    assert unauthed.get("/stream").status_code in (200, 204)


# ── Protected endpoints — no token → 401 ─────────────────────────────────────


def test_status_requires_token(unauthed):
    assert unauthed.get("/status").status_code == 401


def test_devices_requires_token(unauthed):
    assert unauthed.get("/devices").status_code == 401


def test_pair_list_requires_token(unauthed):
    assert unauthed.get("/pair/airplay").status_code == 401


def test_similar_artists_requires_token(unauthed):
    assert unauthed.get("/recommendations/similar-artists?seed=Radiohead").status_code == 401


def test_artist_images_requires_token(unauthed):
    assert unauthed.get("/recommendations/artist-images?name=Radiohead").status_code == 401


# ── Protected endpoints — wrong token → 401 ──────────────────────────────────


def test_status_wrong_token_rejected(wrong_token):
    assert wrong_token.get("/status").status_code == 401


def test_pair_list_wrong_token_rejected(wrong_token):
    assert wrong_token.get("/pair/airplay").status_code == 401


# ── Correct token via X-Connect-Token header ──────────────────────────────────


def test_status_correct_token_accepted(client):
    assert client.get("/status").status_code == 200


def test_devices_correct_token_accepted(client):
    # 503 when no media server configured — but not 401, so auth passed
    assert client.get("/devices").status_code != 401


# ── Correct token via ?token= query param ─────────────────────────────────────


def test_status_token_query_param_accepted():
    with TestClient(app) as c:
        assert c.get(f"/status?token={auth.TOKEN}").status_code == 200


def test_status_wrong_query_param_rejected():
    with TestClient(app) as c:
        assert c.get("/status?token=wrong").status_code == 401


# ── /events (SSE) — EventSource can only use ?token= ─────────────────────────
# The ?token= mechanism is tested via /status above.
# Only rejection cases are tested here — the SSE stream never terminates
# naturally, so a success-case streaming test would hang the suite.


def test_events_no_token_rejected():
    with TestClient(app) as c:
        assert c.get("/events").status_code == 401


def test_events_wrong_token_rejected():
    with TestClient(app) as c:
        assert c.get("/events?token=wrong").status_code == 401


# ── _resolve_token() ─────────────────────────────────────────────────────────
# Module-level TOKEN is resolved once at import time — these drive
# _resolve_token() itself directly (fresh env/file state each time).


def test_resolve_token_prefers_the_launchers_token_over_a_persisted_file(tmp_path, monkeypatch):
    monkeypatch.setenv("CONNECT_INTERNAL_TOKEN", "from-launcher")
    token_file = tmp_path / ".connect-token"
    token_file.write_text("persisted-token")

    with patch.object(auth, "_TOKEN_FILE", token_file):
        assert auth._resolve_token() == "from-launcher"


def test_resolve_token_ignores_the_old_connect_token_setting(tmp_path, monkeypatch):
    """CONNECT_TOKEN is no longer a setting: a leftover one in .env or a compose
    file must not win over the token Electron and vite read from the file."""
    monkeypatch.delenv("CONNECT_INTERNAL_TOKEN", raising=False)
    monkeypatch.setenv("CONNECT_TOKEN", "leftover")
    token_file = tmp_path / ".connect-token"
    token_file.write_text("persisted-token")

    with patch.object(auth, "_TOKEN_FILE", token_file):
        assert auth._resolve_token() == "persisted-token"


def test_resolve_token_reuses_a_previously_persisted_token(tmp_path, monkeypatch):
    monkeypatch.delenv("CONNECT_INTERNAL_TOKEN", raising=False)
    token_file = tmp_path / ".connect-token"
    token_file.write_text("persisted-token")

    with patch.object(auth, "_TOKEN_FILE", token_file):
        assert auth._resolve_token() == "persisted-token"


def test_resolve_token_generates_and_persists_a_fresh_one_when_nothing_exists(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("CONNECT_INTERNAL_TOKEN", raising=False)
    token_file = tmp_path / ".connect-token"

    with patch.object(auth, "_TOKEN_FILE", token_file):
        token = auth._resolve_token()

    assert len(token) == 64  # secrets.token_hex(32) — 32 bytes, hex-encoded
    assert token_file.read_text() == token


def test_resolve_token_reruns_generate_a_different_token_each_time(tmp_path, monkeypatch):
    """Sanity check that these aren't somehow predictable/constant."""
    monkeypatch.delenv("CONNECT_INTERNAL_TOKEN", raising=False)

    with patch.object(auth, "_TOKEN_FILE", tmp_path / "a"):
        token_a = auth._resolve_token()
    with patch.object(auth, "_TOKEN_FILE", tmp_path / "b"):
        token_b = auth._resolve_token()

    assert token_a != token_b


def test_resolve_token_treats_a_whitespace_only_persisted_file_as_absent(tmp_path, monkeypatch):
    monkeypatch.delenv("CONNECT_INTERNAL_TOKEN", raising=False)
    token_file = tmp_path / ".connect-token"
    token_file.write_text("   \n")  # .strip()'d to empty — falls through to generation

    with patch.object(auth, "_TOKEN_FILE", token_file):
        token = auth._resolve_token()

    assert token.strip() != ""
    assert token_file.read_text() == token  # overwritten with the freshly generated one


def test_resolve_token_still_returns_a_fresh_token_when_persisting_fails(tmp_path, monkeypatch):
    """Not fatal — just loses stability across restarts. A path whose parent
    directory doesn't exist fails both the read (FileNotFoundError, already
    handled) and the write (also an OSError) the same way a permissions
    error would."""
    monkeypatch.delenv("CONNECT_INTERNAL_TOKEN", raising=False)
    unwritable = tmp_path / "no-such-dir" / ".connect-token"

    with patch.object(auth, "_TOKEN_FILE", unwritable):
        token = auth._resolve_token()

    assert len(token) == 64
    assert not unwritable.exists()
