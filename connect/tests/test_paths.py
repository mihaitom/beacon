"""core/paths.py - where persistent files go when CONNECT_DATA_DIR is unset."""

import os

import pytest

from core import paths


def test_explicit_data_dir_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("CONNECT_DATA_DIR", str(tmp_path / "explicit"))
    assert paths.data_dir() == str(tmp_path / "explicit")


@pytest.fixture
def no_explicit_dir(monkeypatch, tmp_path):
    monkeypatch.delenv("CONNECT_DATA_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    return tmp_path


def test_default_is_outside_the_checkout(no_explicit_dir):
    connect_dir = os.path.dirname(os.path.dirname(os.path.abspath(paths.__file__)))
    path = paths.data_dir()
    assert not path.startswith(connect_dir)
    assert path.startswith(str(no_explicit_dir))


def test_default_is_created(no_explicit_dir):
    # Several modules write without creating the folder first.
    assert os.path.isdir(paths.data_dir())


def test_linux_follows_xdg(no_explicit_dir, monkeypatch):
    monkeypatch.setattr(paths.sys, "platform", "linux")
    assert paths.data_dir() == str(no_explicit_dir / "xdg" / "beacon-connect")


def test_windows_uses_local_appdata(no_explicit_dir, monkeypatch):
    monkeypatch.setattr(paths.sys, "platform", "win32")
    assert paths.data_dir() == os.path.join(str(no_explicit_dir / "local"), "beacon-connect")


def test_unwritable_default_does_not_raise(no_explicit_dir, monkeypatch):
    blocker = no_explicit_dir / "xdg"
    blocker.write_text("a file where the folder should be")
    monkeypatch.setattr(paths.sys, "platform", "linux")
    assert paths.data_dir() == str(blocker / "beacon-connect")
