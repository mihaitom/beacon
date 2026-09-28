"""Tests for core/ffmpeg.py — which executable the backend actually runs.

The desktop app ships its own build and points the backend at it with
FFMPEG_PATH (see build/ffmpeg/README.md). Every module that shells out has
to go through that, or a packaged install silently keeps using whatever
ffmpeg happens to be on the user's PATH — or none at all.
"""

import importlib
from unittest.mock import patch

import core.ffmpeg


def _reload_with_env(value: str | None):
    env = {} if value is None else {"FFMPEG_PATH": value}
    with patch.dict("os.environ", env, clear=False):
        if value is None:
            import os

            os.environ.pop("FFMPEG_PATH", None)
        return importlib.reload(core.ffmpeg)


def test_ffmpeg_path_env_selects_the_executable():
    module = _reload_with_env("/opt/beacon/ffmpeg")
    try:
        assert module.FFMPEG_BIN == "/opt/beacon/ffmpeg"
    finally:
        _reload_with_env(None)


def test_without_the_env_it_is_the_plain_name_from_path():
    """What a development checkout and the Docker image both get, and what
    this backend did before any of this existed."""
    module = _reload_with_env(None)
    assert module.FFMPEG_BIN == "ffmpeg"


def test_an_empty_env_value_falls_back_rather_than_running_nothing():
    module = _reload_with_env("")
    try:
        assert module.FFMPEG_BIN == "ffmpeg"
    finally:
        _reload_with_env(None)


def test_availability_reports_a_configured_path_that_does_not_exist():
    """A packaged binary that didn't make it into the bundle has to surface
    as "ffmpeg missing" in /health, not as a stream that fails later."""
    module = _reload_with_env("/nonexistent/ffmpeg")
    try:
        assert module.ffmpeg_available() is False
    finally:
        _reload_with_env(None)


def test_ffmpeg_is_given_connects_own_ca_bundle():
    """The bundled Windows/macOS ffmpeg otherwise looks for CAs at a path
    that only exists on the machine it was built on, and refuses every
    https media server (#37)."""
    import os

    import certifi

    with patch.dict("os.environ", {}, clear=False):
        os.environ.pop("SSL_CERT_FILE", None)
        core.ffmpeg.trust_what_connect_trusts()
        assert os.environ["SSL_CERT_FILE"] == certifi.where()


def test_an_explicit_ca_bundle_is_left_alone():
    """Someone running their media server behind a private CA points this
    at their own bundle; that must not be overwritten."""
    import os

    with patch.dict("os.environ", {"SSL_CERT_FILE": "/etc/private-ca.pem"}, clear=False):
        core.ffmpeg.trust_what_connect_trusts()
        assert os.environ["SSL_CERT_FILE"] == "/etc/private-ca.pem"


def test_no_module_shells_out_to_a_hardcoded_ffmpeg():
    """The point of the whole thing: one place to change, and no module left
    naming the executable itself. A call site that hardcodes it keeps working
    on any machine with ffmpeg on PATH and fails only where the bundled build
    is the only one there is — so this reads the source rather than the built
    commands, which is also the only way to cover the ones assembled inside a
    function."""
    import re
    from pathlib import Path

    # The literal as a value — a list element, an argument — but not as a
    # dict key, which is what /health reports its availability under.
    executable = re.compile(r"""["']ffmpeg["'](?!\s*:)""")
    connect_dir = Path(__file__).resolve().parent.parent
    offenders = []
    for path in list((connect_dir / "core").glob("*.py")) + list(
        (connect_dir / "routes").glob("*.py")
    ):
        if path.name == "ffmpeg.py":
            continue
        for number, line in enumerate(path.read_text().splitlines(), start=1):
            if executable.search(line.split("#")[0]):
                offenders.append(f"{path.name}:{number}")
    assert offenders == [], f"hardcoded ffmpeg executable at: {', '.join(offenders)}"
