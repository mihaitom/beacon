import os

import pytest

from folder_source.config import load


@pytest.mark.skipif(os.getuid() == 0, reason="root may write anywhere")
def test_a_data_folder_it_cannot_write_to_is_named(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    data.chmod(0o500)
    monkeypatch.setenv("DATA_DIR", str(data))
    monkeypatch.delenv("SECRET", raising=False)
    try:
        with pytest.raises(SystemExit, match="Cannot write to .*chown"):
            load(["main.py", str(tmp_path)])
    finally:
        data.chmod(0o700)
