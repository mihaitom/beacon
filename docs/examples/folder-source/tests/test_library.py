import sqlite3

from folder_source import library as library_module
from folder_source.library import VARIOUS, Library


def _album(library, title):
    return next(a for a in library.albums.values() if a.title == title)


def test_tags_win_over_names(library):
    album = _album(library, "Polarnacht")
    assert album.artist == "Nordlicht"
    assert album.year == 2024
    assert album.genre == "Ambient"
    assert [t.title for t in album.tracks] == ["Erster Schnee", "Lange Nacht"]
    assert album.tracks[0].duration > 1.5


def test_an_untagged_file_is_named_by_its_folders(library):
    album = _album(library, "Best Of")
    assert album.artist == "Die Ärzte"
    track = album.tracks[0]
    assert (track.title, track.track) == ("Schrei nach Liebe", 3)


def test_a_compilation_stays_one_album(library):
    album = _album(library, "Sommer")
    assert len(album.tracks) == 3
    assert album.artist == VARIOUS
    assert [t.artist for t in album.tracks] == ["Anna", "Ben", "Cleo"]


def test_disc_folders_make_one_album(library):
    album = _album(library, "Doppel")
    assert [(t.disc, t.title) for t in album.tracks] == [(1, "A"), (2, "B")]


def test_covers_come_from_a_file_or_a_track(library):
    assert _album(library, "Polarnacht").cover == ("file", "Nordlicht/Polarnacht/Cover.JPG")
    kind, path = _album(library, "Sommer").cover
    assert (kind, path) == ("embedded", "Compilations/Sommer/02 Song.mp3")
    assert _album(library, "Best Of").cover is None


def test_loose_files_get_an_album_of_their_own(library):
    assert [t.title for t in _album(library, "Loose songs").tracks] == ["Intro"]


def test_only_audio_is_indexed(library):
    assert not any(t.path.endswith(".txt") for t in library.tracks.values())
    assert len(library.tracks) == 9


def test_ids_stay_the_same_across_scans(config, library):
    again = Library(config.music_dir, config.data_dir / "other.sqlite")
    again.scan()
    assert set(again.tracks) == set(library.tracks)
    assert set(again.albums) == set(library.albums)


def test_a_second_scan_reads_only_what_changed(config, library, monkeypatch, music):
    calls = []
    real = library_module.read_track
    monkeypatch.setattr(library_module, "read_track", lambda *a: calls.append(a) or real(*a))
    library.scan()
    assert calls == []
    (music / "Intro.mp3").touch()
    library.scan()
    assert len(calls) == 1


def test_a_symlink_out_of_the_folder_is_not_followed(config, tmp_path_factory, music):
    outside = tmp_path_factory.mktemp("outside")
    secret = outside / "secret.mp3"
    secret.write_bytes((music / "Intro.mp3").read_bytes())
    links = [music / "escape", music / "secret.mp3"]
    links[0].symlink_to(outside)
    links[1].symlink_to(secret)
    try:
        scanned = Library(config.music_dir, config.data_dir / "x.sqlite")
        scanned.scan()
        assert not any("secret" in t.path for t in scanned.tracks.values())
    finally:
        for link in links:
            link.unlink()


def test_search_needs_every_word_somewhere(library):
    albums, tracks = library.search("nordlicht nacht")
    assert [a.title for a in albums] == ["Polarnacht"]
    assert [t.title for t in tracks] == ["Erster Schnee", "Lange Nacht"]
    albums, tracks = library.search("lange")
    assert (albums, [t.title for t in tracks]) == ([], ["Lange Nacht"])
    assert library.search("nordlicht cleo") == ([], [])


def test_a_restart_reads_nothing_that_did_not_change(config, library, monkeypatch):
    calls = []
    real = library_module.read_track
    monkeypatch.setattr(library_module, "read_track", lambda *a: calls.append(a) or real(*a))
    restarted = Library(config.music_dir, config.data_dir / "library.sqlite")
    restarted.scan()
    assert calls == []
    assert set(restarted.tracks) == set(library.tracks)


def test_a_deleted_file_leaves_the_index(config, tmp_path_factory, music):
    extra = music / "Extra.mp3"
    extra.write_bytes((music / "Intro.mp3").read_bytes())
    index = config.data_dir / "gone.sqlite"
    try:
        Library(config.music_dir, index).scan()
    finally:
        extra.unlink()
    again = Library(config.music_dir, index)
    again.scan()
    assert not any(t.path == "Extra.mp3" for t in again.tracks.values())
    with sqlite3.connect(index) as conn:
        paths = {row[0] for row in conn.execute("SELECT path FROM tracks")}
    assert "Extra.mp3" not in paths


def test_a_scan_cut_short_keeps_what_it_read(config, monkeypatch):
    index = config.data_dir / "cut.sqlite"
    monkeypatch.setattr(library_module, "_WRITE_EVERY", 2)
    real = library_module.read_track
    count = 0

    def crash_on_the_fifth(*args):
        nonlocal count
        count += 1
        if count == 5:
            raise KeyboardInterrupt
        return real(*args)

    monkeypatch.setattr(library_module, "read_track", crash_on_the_fifth)
    try:
        Library(config.music_dir, index).scan()
    except KeyboardInterrupt:
        pass
    with sqlite3.connect(index) as conn:
        assert conn.execute("SELECT count(*) FROM tracks").fetchone()[0] == 4


def test_the_old_json_cache_is_cleared_away(config):
    old = config.data_dir / "library.json"
    old.write_text("{}")
    Library(config.music_dir, config.data_dir / "library.sqlite")
    assert not old.exists()


def test_a_scan_counts_what_it_found_and_what_it_still_has_to_read(config, monkeypatch):
    library = Library(config.music_dir, config.data_dir / "progress.sqlite")
    seen = []
    real = library_module.read_track

    def watched(*args):
        p = library.progress
        seen.append((p.phase, p.found, p.to_read, p.read))
        return real(*args)

    monkeypatch.setattr(library_module, "read_track", watched)
    library.scan()
    assert seen == [("reading", 9, 9, n) for n in range(9)]
    assert library.progress.phase == ""
    assert (library.progress.read, library.progress.to_read) == (9, 9)


def test_a_rescan_has_only_the_changed_files_to_read(config, library, music):
    (music / "Intro.mp3").touch()
    library.scan()
    assert (library.progress.found, library.progress.to_read) == (9, 1)
