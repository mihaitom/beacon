import os

import pytest

from live_music_archive.config import load


@pytest.mark.skipif(os.getuid() == 0, reason="root may write anywhere")
def test_a_data_folder_it_cannot_write_to_is_named(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    data.chmod(0o500)
    monkeypatch.setenv("DATA_DIR", str(data))
    monkeypatch.delenv("SECRET", raising=False)
    try:
        with pytest.raises(SystemExit, match="Cannot write to .*chown"):
            load()
    finally:
        data.chmod(0o700)


def test_the_secret_is_made_once_and_kept(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SECRET", raising=False)
    assert load().secret == load().secret
    assert (tmp_path / "secret").stat().st_mode & 0o777 == 0o600
