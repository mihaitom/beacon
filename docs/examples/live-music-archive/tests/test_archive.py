from live_music_archive.archive import _duration, _ordered, _terms, recording


def test_lengths_come_as_seconds_or_as_clock_time():
    assert _duration("451.5") == 451.5
    assert _duration("07:31") == 451
    assert _duration("1:02:03") == 3723
    assert _duration("") is None
    assert _duration("about five minutes") is None


def test_search_text_cannot_change_the_query_around_it():
    assert _terms("grateful dead") == "grateful AND dead"
    assert _terms("x) OR (collection:stream_only") == r"x\) AND OR AND \(collection\:stream_only"
    assert _terms("   ") == ""
    assert _terms("red rocks", ("venue", "title")) == (
        "(venue:red OR title:red) AND (venue:rocks OR title:rocks)"
    )


def test_tracks_go_by_number_when_each_has_its_own():
    files = [{"name": "b.mp3", "track": "2"}, {"name": "c.mp3", "track": "1/2"}]
    assert [f["name"] for f in _ordered(files)] == ["c.mp3", "b.mp3"]


def test_tracks_go_by_name_when_numbers_repeat_or_are_missing():
    files = [
        {"name": "d2t01.mp3", "track": "01"},
        {"name": "d1t10.mp3", "track": "10"},
        {"name": "d1t02.mp3", "track": "02"},
        {"name": "d1t01.mp3", "track": "01"},
    ]
    assert [f["name"] for f in _ordered(files)] == [
        "d1t01.mp3",
        "d1t02.mp3",
        "d1t10.mp3",
        "d2t01.mp3",
    ]
    assert [f["name"] for f in _ordered([{"name": "b"}, {"name": "a", "track": "1"}])] == [
        "a",
        "b",
    ]


def test_the_recording_is_named_by_the_taper_or_the_identifier():
    assert recording("gd1995-07-09.sbd.miller.114369.flac16") == "Soundboard"
    assert recording("gd1970-09-19.mtx.chappell.SB14.31510.sbeok.flac16") == "Matrix"
    assert recording("band1977-05-08.aud") == "Audience"
    # Only whole words: "audio" or "saudade" is no audience tape.
    assert recording("audio-saudade2001") == ""
    assert recording("gd1995-07-09.sbd.x", "SBD -> Dat (44.1k)") == "SBD -> Dat (44.1k)"
    assert recording("x.147057", "Source:  Audio Technica\n835b") == "Audio Technica 835b"
    assert recording("x.aud.y", ["?"]) == "Audience"
