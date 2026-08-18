"""Tests for token-based auth (core/auth.py + require_token dependency)."""

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
