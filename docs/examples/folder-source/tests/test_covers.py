import io
import os

from PIL import Image

from folder_source.covers import THUMB_SIZE, read_cover, read_thumbnail


def _jpeg(path, size):
    Image.new("RGB", size, "teal").save(path, "JPEG")
    return path


def test_a_large_cover_is_shrunk_for_the_tiles(tmp_path):
    path = _jpeg(tmp_path / "cover.jpg", (2000, 1500))
    data, content_type = read_thumbnail("file", path)
    assert content_type == "image/jpeg"
    with Image.open(io.BytesIO(data)) as image:
        assert max(image.size) == THUMB_SIZE
    # The original stays as it is, for the album page and for Beacon.
    assert read_cover("file", path)[0] == path.read_bytes()


def test_a_cover_that_is_no_picture_is_passed_on_unchanged(tmp_path):
    path = tmp_path / "cover.jpg"
    path.write_bytes(b"not a picture")
    assert read_thumbnail("file", path) == (b"not a picture", "image/jpeg")


def test_a_changed_cover_gets_a_new_thumbnail(tmp_path):
    path = _jpeg(tmp_path / "cover.jpg", (800, 800))
    first = read_thumbnail("file", path)
    Image.new("RGB", (800, 800), "red").save(path, "JPEG")
    os.utime(path, (1, 1))
    assert read_thumbnail("file", path) != first
