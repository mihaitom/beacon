"""Album covers: a picture file in the album's folder, or the one embedded in
a track."""

import mimetypes
from functools import lru_cache
from pathlib import Path

import mutagen


@lru_cache(maxsize=256)
def _embedded(path: str, mtime: float) -> tuple[bytes, str] | None:
    # mtime only keys the cache: a re-tagged file gets read again.
    try:
        audio = mutagen.File(path)
    except Exception:
        return None
    if audio is None:
        return None
    pictures = getattr(audio, "pictures", None)  # FLAC
    if pictures:
        return pictures[0].data, pictures[0].mime or "image/jpeg"
    tags = audio.tags
    if tags is None:
        return None
    if hasattr(tags, "getall"):  # ID3
        frames = tags.getall("APIC")
        front = next((f for f in frames if f.type == 3), frames[0] if frames else None)
        return (front.data, front.mime or "image/jpeg") if front else None
    covers = tags.get("covr") if hasattr(tags, "get") else None  # MP4
    if covers:
        cover = covers[0]
        png = getattr(cover, "imageformat", None) == 14
        return bytes(cover), "image/png" if png else "image/jpeg"
    blocks = tags.get("metadata_block_picture") if hasattr(tags, "get") else None  # Ogg
    if blocks:
        import base64

        from mutagen.flac import Picture

        picture = Picture(base64.b64decode(blocks[0]))
        return picture.data, picture.mime or "image/jpeg"
    return None


def read_cover(kind: str, path: Path) -> tuple[bytes, str] | None:
    """(bytes, content type) of a cover, or None."""
    if kind == "file":
        try:
            data = path.read_bytes()
        except OSError:
            return None
        return data, mimetypes.guess_type(path.name)[0] or "image/jpeg"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    return _embedded(str(path), mtime)
