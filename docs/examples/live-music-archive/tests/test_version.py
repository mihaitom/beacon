import tomllib
from pathlib import Path

from live_music_archive import __version__


def test_the_app_reports_the_version_the_image_is_tagged_with():
    pyproject = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text())
    assert __version__ == pyproject["project"]["version"]
