"""Tests for core/account_settings.py + routes/account_settings.py — the
settings that follow an account across devices (language, recommendations
opt-in, lyrics providers, autoplay batch size). See that module's own
docstring for why this exists and how it's scoped (a partition key, not a
credential — CONNECT_TOKEN stays the real security boundary)."""

import os
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from core import account_settings
from main import app


@pytest.fixture
def unauthed():
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _tmp_path(tmp_dir: str) -> str:
    return str(Path(tmp_dir) / "test_account_settings.json")


@pytest.fixture(autouse=True)
def _isolated_storage():
    """Same isolation pattern as test_log_level.py's _PATH patch — real
    account_settings.json under CONNECT_DATA_DIR must never be touched by
    the test suite."""
    with tempfile.TemporaryDirectory() as d:
        with patch.object(account_settings, "_PATH", _tmp_path(d)):
            yield


# ── core/account_settings.py — plain unit tests ──────────────────────────


def test_load_is_empty_for_an_account_that_has_never_synced():
    assert account_settings.load("subsonic", "https://music.example.com", "alice") == {}


def test_save_then_load_round_trips():
    account_settings.save("subsonic", "https://music.example.com", "alice", {"locale": "de"})

    assert account_settings.load("subsonic", "https://music.example.com", "alice") == {
        "locale": "de"
    }


def test_save_merges_rather_than_replacing():
    account_settings.save("subsonic", "https://music.example.com", "alice", {"locale": "de"})
    account_settings.save(
        "subsonic",
        "https://music.example.com",
        "alice",
        {"recommendationsEnabled": False},
    )

    assert account_settings.load("subsonic", "https://music.example.com", "alice") == {
        "locale": "de",
        "recommendationsEnabled": False,
    }


def test_save_overwrites_only_the_given_field():
    account_settings.save("subsonic", "https://music.example.com", "alice", {"locale": "de"})
    account_settings.save("subsonic", "https://music.example.com", "alice", {"locale": "en"})

    assert account_settings.load("subsonic", "https://music.example.com", "alice") == {
        "locale": "en"
    }


def test_different_accounts_do_not_share_settings():
    account_settings.save("subsonic", "https://music.example.com", "alice", {"locale": "de"})

    assert account_settings.load("subsonic", "https://music.example.com", "bob") == {}


def test_same_account_on_a_different_server_url_is_a_different_account():
    account_settings.save("subsonic", "https://music.example.com", "alice", {"locale": "de"})

    assert account_settings.load("subsonic", "https://other.example.com", "alice") == {}


def test_load_never_leaks_the_identity_fields_stashed_alongside_settings():
    account_settings.save("subsonic", "https://music.example.com", "alice", {"locale": "de"})

    loaded = account_settings.load("subsonic", "https://music.example.com", "alice")
    assert "identity" not in loaded


# ── routes/account_settings.py — HTTP level ──────────────────────────────


def test_get_requires_token(unauthed):
    resp = unauthed.get(
        "/account-settings",
        params={
            "server_type": "subsonic",
            "server_url": "https://music.example.com",
            "username": "alice",
        },
    )
    assert resp.status_code == 401


def test_get_returns_empty_dict_for_an_unknown_account(client):
    resp = client.get(
        "/account-settings",
        params={
            "server_type": "subsonic",
            "server_url": "https://music.example.com",
            "username": "alice",
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {}


def test_post_then_get_round_trips_through_http(client):
    post = client.post(
        "/account-settings",
        json={
            "server_type": "subsonic",
            "server_url": "https://music.example.com",
            "username": "alice",
            "settings": {"locale": "de", "autoplayBatchSize": 20},
        },
    )
    assert post.status_code == 200
    assert post.json() == {"locale": "de", "autoplayBatchSize": 20}

    get = client.get(
        "/account-settings",
        params={
            "server_type": "subsonic",
            "server_url": "https://music.example.com",
            "username": "alice",
        },
    )
    assert get.json() == {"locale": "de", "autoplayBatchSize": 20}


def test_post_a_single_field_does_not_clobber_previously_synced_ones(client):
    client.post(
        "/account-settings",
        json={
            "server_type": "subsonic",
            "server_url": "https://music.example.com",
            "username": "alice",
            "settings": {"locale": "de", "recommendationsEnabled": True},
        },
    )

    resp = client.post(
        "/account-settings",
        json={
            "server_type": "subsonic",
            "server_url": "https://music.example.com",
            "username": "alice",
            "settings": {"recommendationsEnabled": False},
        },
    )

    assert resp.json() == {"locale": "de", "recommendationsEnabled": False}


# ── Durability: this one file holds *every* account's settings ───────────


def test_an_interrupted_write_leaves_the_previous_file_intact(monkeypatch):
    """The real durability property, exercised the way it actually breaks:
    a write that dies partway (crash, full disk). Written into a temp file
    and moved into place with os.replace(), so the live file is either the
    old one or the new one — a truncate-in-place would have emptied it and
    taken every account in it down with the failed write."""
    account_settings.save("subsonic", "https://music.example.com", "alice", {"locale": "de"})

    def boom(*args, **kwargs):
        raise OSError("No space left on device")

    monkeypatch.setattr(account_settings.json, "dump", boom)
    account_settings.save("subsonic", "https://music.example.com", "bob", {"locale": "en"})
    monkeypatch.undo()

    assert account_settings.load("subsonic", "https://music.example.com", "alice") == {
        "locale": "de"
    }
    assert not os.path.exists(f"{account_settings._PATH}.tmp")


def test_save_does_not_wipe_other_accounts_when_the_store_is_unreadable():
    account_settings.save("subsonic", "https://music.example.com", "alice", {"locale": "de"})
    with open(account_settings._PATH, "w", encoding="utf-8") as f:
        f.write('{"truncated": ')  # e.g. a crash mid-write by an older build

    account_settings.save("subsonic", "https://music.example.com", "bob", {"locale": "en"})

    # Alice's settings are gone from the live file either way — they were
    # in the damaged half. What must not happen is losing them *silently*:
    # the unreadable copy is kept for recovery instead of overwritten.
    assert account_settings.load("subsonic", "https://music.example.com", "bob") == {"locale": "en"}
    with open(f"{account_settings._PATH}.corrupt", encoding="utf-8") as f:
        assert f.read() == '{"truncated": '


def test_load_treats_an_unreadable_store_as_never_synced():
    with open(account_settings._PATH, "w", encoding="utf-8") as f:
        f.write("not json at all")

    assert account_settings.load("subsonic", "https://music.example.com", "alice") == {}


def test_concurrent_saves_do_not_lose_each_other():
    """Two devices belonging to the same person routinely push at the same
    moment (both come out of the same login), and save() is a
    read-modify-write over a shared file — without the lock the later write
    would be built on a copy read before the earlier one landed."""
    fields = [f"field{i}" for i in range(20)]
    barrier = threading.Barrier(len(fields))

    def push(field: str) -> None:
        barrier.wait()
        account_settings.save("subsonic", "https://music.example.com", "alice", {field: True})

    threads = [threading.Thread(target=push, args=(f,)) for f in fields]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    stored = account_settings.load("subsonic", "https://music.example.com", "alice")
    assert sorted(stored) == sorted(fields)
