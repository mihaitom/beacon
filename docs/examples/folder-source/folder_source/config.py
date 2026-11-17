"""Settings, from the environment (and the music folders from the command line,
for a quick start)."""

import os
import re
import secrets
from dataclasses import dataclass
from pathlib import Path

from .library import sort_text


@dataclass(frozen=True)
class MusicFolder:
    """One folder, shown as its own tab in the page."""

    # In the page's and the songs' addresses: renaming the folder makes its
    # songs new ones to Beacon.
    key: str
    name: str
    path: Path


@dataclass(frozen=True)
class Config:
    folders: tuple[MusicFolder, ...]
    data_dir: Path
    name: str
    # Required on every request Beacon passes on to /v1 and /ui/ when set.
    token: str
    # Signs audio and cover addresses, which Beacon and the speakers fetch
    # without any header.
    secret: bytes
    rescan_minutes: float
    host: str
    port: int


def _secret(data_dir: Path) -> bytes:
    """SECRET if set, otherwise one made on first start and kept: a new one
    would change every song's address, and Beacon would treat them as new
    songs."""
    explicit = os.environ.get("SECRET", "")
    if explicit:
        return explicit.encode()
    path = data_dir / "secret"
    try:
        return path.read_bytes().strip()
    except FileNotFoundError:
        value = secrets.token_urlsafe(32).encode()
        path.write_bytes(value)
        path.chmod(0o600)
        return value


def music_folders(paths: list[str]) -> tuple[MusicFolder, ...]:
    """Each folder is named after itself: in Docker, the name it is mounted under."""
    folders: list[MusicFolder] = []
    for given in paths:
        path = Path(given).expanduser().resolve()
        if not path.is_dir():
            raise SystemExit(f"Not a folder: {path}")
        name = path.name or str(path)
        if any(f.name == name for f in folders):
            raise SystemExit(f'Two folders are called "{name}". Give one of them another name.')
        key = re.sub(r"[^a-z0-9]+", "-", sort_text(name)).strip("-") or "folder"
        taken = {f.key for f in folders}
        unique, n = key, 2
        while unique in taken:
            unique, n = f"{key}-{n}", n + 1
        folders.append(MusicFolder(key=unique, name=name, path=path))
    return tuple(folders)


def load(argv: list[str]) -> Config:
    paths = argv[1:] or [p for p in os.environ.get("MUSIC_DIR", "").split(os.pathsep) if p]
    if not paths:
        raise SystemExit("Which folders? Pass them as arguments or set MUSIC_DIR.")
    folders = music_folders(paths)
    data_dir = Path(os.environ.get("DATA_DIR", "data")).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    if not os.access(data_dir, os.W_OK):
        # Docker makes a missing bind-mount folder as root.
        raise SystemExit(
            f"Cannot write to {data_dir} as uid {os.getuid()}. "
            f"Give it to this user, e.g. chown {os.getuid()} <the folder on the host>."
        )
    return Config(
        folders=folders,
        data_dir=data_dir,
        name=os.environ.get("SOURCE_NAME", "Music folder"),
        token=os.environ.get("TOKEN", ""),
        secret=_secret(data_dir),
        rescan_minutes=float(os.environ.get("RESCAN_MINUTES", "30")),
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8800")),
    )
