import os

import pytest

from folder_source.config import load, music_folders


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


def test_folders_are_named_and_keyed_after_themselves(tmp_path):
    for name in ("Imports", "DJ Sets", "Ärzte & Co"):
        (tmp_path / name).mkdir()
    folders = music_folders([str(tmp_path / n) for n in ("Imports", "DJ Sets", "Ärzte & Co")])
    assert [(f.key, f.name) for f in folders] == [
        ("imports", "Imports"),
        ("dj-sets", "DJ Sets"),
        ("arzte-co", "Ärzte & Co"),
    ]


def test_two_names_with_the_same_key_get_two_keys(tmp_path):
    for name in ("DJ Sets", "DJ-Sets"):
        (tmp_path / name).mkdir()
    folders = music_folders([str(tmp_path / "DJ Sets"), str(tmp_path / "DJ-Sets")])
    assert [f.key for f in folders] == ["dj-sets", "dj-sets-2"]


def test_two_folders_of_the_same_name_are_refused(tmp_path):
    for parent in ("a", "b"):
        (tmp_path / parent / "Music").mkdir(parents=True)
    with pytest.raises(SystemExit, match='Two folders are called "Music"'):
        music_folders([str(tmp_path / "a/Music"), str(tmp_path / "b/Music")])


def test_music_dir_takes_several_folders(tmp_path, monkeypatch):
    for name in ("One", "Two"):
        (tmp_path / name).mkdir()
    monkeypatch.setenv("MUSIC_DIR", f"{tmp_path / 'One'}{os.pathsep}{tmp_path / 'Two'}")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    assert [f.name for f in load(["main.py"]).folders] == ["One", "Two"]
