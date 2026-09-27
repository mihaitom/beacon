import os
import stat

import pytest

from media import client_id


def _restart():
    client_id.forget_cached_ids()


def test_id_stays_the_same_while_it_cannot_be_saved(monkeypatch, tmp_path):
    # Program Files on Windows: the data dir exists but is not writable.
    blocked = tmp_path / "blocked"
    blocked.mkdir()
    monkeypatch.setattr(client_id, "_DATA_DIR", str(blocked / "sub"))
    blocked.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        if os.access(blocked, os.W_OK):
            pytest.skip("running as a user that ignores directory permissions")
        first = client_id.stable_id(".jellyfin-device-id")
        assert len(first) == 32
        assert all(client_id.stable_id(".jellyfin-device-id") == first for _ in range(5))
    finally:
        blocked.chmod(stat.S_IRWXU)


def test_id_survives_a_restart():
    first = client_id.stable_id(".jellyfin-device-id")
    _restart()
    assert client_id.stable_id(".jellyfin-device-id") == first


def test_jellyfin_and_plex_get_separate_ids():
    assert client_id.stable_id(".jellyfin-device-id") != client_id.stable_id(".plex-client-id")


def test_id_saved_next_to_the_code_is_carried_over(tmp_path):
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    (legacy / ".plex-client-id").write_text("old-id\n")

    assert client_id.stable_id(".plex-client-id") == "old-id"
    assert (tmp_path / "data" / ".plex-client-id").read_text() == "old-id"


def test_saved_id_wins_over_the_old_location(tmp_path):
    for name, value in (("legacy", "old-id"), ("data", "new-id")):
        (tmp_path / name).mkdir()
        (tmp_path / name / ".plex-client-id").write_text(value)

    assert client_id.stable_id(".plex-client-id") == "new-id"
