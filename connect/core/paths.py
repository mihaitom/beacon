"""core/paths.py - where connect keeps its persistent files

CONNECT_DATA_DIR wins when set: Electron sets it to the app's userData path
(the packaged binary's own folder is replaced on every update), Docker's
start.sh defaults it to /data. A bare source checkout (`pnpm dev`,
`uv run python main.py`) gets the platform's per-user data folder instead
of the checkout itself, so credentials and API keys never sit next to code
that gets committed. It is deliberately not the desktop app's own folder:
a dev session must not share pairings and settings with the installed app.
"""

import os
import sys

_APP_NAME = "beacon-connect"


def _default_data_dir() -> str:
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
    elif sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    return os.path.join(base, _APP_NAME)


def data_dir() -> str:
    explicit = os.environ.get("CONNECT_DATA_DIR")
    if explicit:
        return explicit
    path = _default_data_dir()
    # Not every module creates the folder before its first write; the
    # checkout these files used to land in always existed.
    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        pass
    return path
