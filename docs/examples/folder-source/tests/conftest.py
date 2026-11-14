import shutil
import subprocess
from pathlib import Path

import pytest
from mutagen.id3 import APIC, ID3
from starlette.testclient import TestClient

from folder_source.app import create_app
from folder_source.config import Config
from folder_source.library import Library

if shutil.which("ffmpeg") is None:
    pytest.skip("ffmpeg is needed to make test audio", allow_module_level=True)

# A 1x1 JPEG is enough to count as a cover.
TINY_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbd3ffd9"
)


def make_mp3(path: Path, seconds: float = 1.0, **tags: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    metadata = [arg for key, value in tags.items() for arg in ("-metadata", f"{key}={value}")]
    subprocess.run(
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=d={seconds}",
            "-b:a",
            "64k",
            *metadata,
            str(path),
        ],
        check=True,
    )
    return path


def embed_cover(path: Path) -> None:
    tags = ID3(path)
    tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="", data=TINY_JPEG))
    tags.save(path)


@pytest.fixture(scope="session")
def music(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("music")
    # Tagged, with a cover file.
    make_mp3(
        root / "Nordlicht/Polarnacht/01 Schnee.mp3",
        2,
        title="Erster Schnee",
        artist="Nordlicht",
        album="Polarnacht",
        track="1/2",
        date="2024",
        genre="Ambient",
    )
    make_mp3(
        root / "Nordlicht/Polarnacht/02 Nacht.mp3",
        1,
        title="Lange Nacht",
        artist="Nordlicht",
        album="Polarnacht",
        track="2/2",
        date="2024",
    )
    (root / "Nordlicht/Polarnacht/Cover.JPG").write_bytes(TINY_JPEG)
    # Untagged: everything comes from the names.
    make_mp3(root / "Die Ärzte/Best Of/03 - Schrei nach Liebe.mp3")
    # A compilation: one folder, every track another artist, embedded cover.
    for n, artist in enumerate(["Anna", "Ben", "Cleo"], 1):
        path = make_mp3(
            root / f"Compilations/Sommer/{n:02} Song.mp3",
            title=f"Song {n}",
            artist=artist,
            album="Sommer",
            track=str(n),
        )
        if n == 2:
            embed_cover(path)
    # Two discs in their own folders: one album.
    make_mp3(root / "Band/Doppel/CD1/01 A.mp3", album="Doppel", artist="Band", disc="1", track="1")
    make_mp3(root / "Band/Doppel/CD2/01 B.mp3", album="Doppel", artist="Band", disc="2", track="1")
    # Loose in the root.
    make_mp3(root / "Intro.mp3")
    (root / "notes.txt").write_text("not music")
    return root


@pytest.fixture
def config(music, tmp_path) -> Config:
    return Config(
        music_dir=music,
        data_dir=tmp_path,
        name="Test folder",
        token="",
        secret=b"test-secret",
        rescan_minutes=0,
        host="127.0.0.1",
        port=0,
    )


@pytest.fixture
def library(config) -> Library:
    library = Library(config.music_dir, config.data_dir / "library.sqlite")
    library.scan()
    return library


@pytest.fixture
def client(config, library):
    with TestClient(create_app(config, library, scan_on_start=False)) as c:
        yield c
