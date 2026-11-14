"""Settings, from the environment (and the music folder from the command line,
for a quick start)."""

import os
import secrets
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    music_dir: Path
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


def load(argv: list[str]) -> Config:
    music = argv[1] if len(argv) > 1 else os.environ.get("MUSIC_DIR", "")
    if not music:
        raise SystemExit("Which folder? Pass it as an argument or set MUSIC_DIR.")
    music_dir = Path(music).expanduser().resolve()
    if not music_dir.is_dir():
        raise SystemExit(f"Not a folder: {music_dir}")
    data_dir = Path(os.environ.get("DATA_DIR", "data")).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    if not os.access(data_dir, os.W_OK):
        # Docker makes a missing bind-mount folder as root.
        raise SystemExit(
            f"Cannot write to {data_dir} as uid {os.getuid()}. "
            f"Give it to this user, e.g. chown {os.getuid()} <the folder on the host>."
        )
    return Config(
        music_dir=music_dir,
        data_dir=data_dir,
        name=os.environ.get("SOURCE_NAME", "Music folder"),
        token=os.environ.get("TOKEN", ""),
        secret=_secret(data_dir),
        rescan_minutes=float(os.environ.get("RESCAN_MINUTES", "30")),
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8800")),
    )
