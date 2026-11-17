"""Tests for core/play_history.py, core/play_history_import.py and
routes/play_history.py."""

import asyncio
import json
import sqlite3
import threading
import time
from unittest.mock import AsyncMock, patch

import pytest

from core import lastfm, listenbrainz, play_history, play_history_import
from core.play_history import Account

ALICE = Account("subsonic", "https://music.example", "alice")
BOB = Account("subsonic", "https://music.example", "bob")
ELSEWHERE = Account("subsonic", "https://other.example", "alice")

NOW = 1_800_000_000
DAY = 86_400


def listen(song_id="s1", **over) -> dict:
    return {"song_id": song_id, "title": f"Title {song_id}", "artist": "Artist", **over}


@pytest.fixture(autouse=True)
def _isolated(tmp_path):
    play_history._last_recorded.clear()
    play_history_import._runs.clear()
    with patch.object(play_history, "_DIR", str(tmp_path)):
        yield


@pytest.fixture
def signed_in(default_session):
    """The default session, verified as alice, not an admin."""
    default_session.account_server_type = ALICE.server_type
    default_session.account_server_url = ALICE.server_url
    default_session.account_username = ALICE.username
    default_session.account_is_admin = False
    return default_session


def imported(ts: int, title="Old", artist="Artist") -> dict:
    return {"ts": ts, "title": title, "artist": artist, "album": "Album"}


# ── recording ────────────────────────────────────────────────────────────


def test_a_recorded_play_is_in_the_summary():
    assert play_history.record(ALICE, listen(), now=NOW)
    summary = play_history.summary(ALICE, now=NOW)
    assert summary["timestamps"] == [NOW]
    assert summary["total"] == 1
    assert summary["live_since"] == NOW


def test_accounts_do_not_share_a_log():
    play_history.record(ALICE, listen(), now=NOW)
    assert play_history.summary(BOB, now=NOW)["total"] == 0
    assert play_history.summary(ELSEWHERE, now=NOW)["total"] == 0


def test_the_same_play_reported_twice_counts_once():
    assert play_history.record(ALICE, listen(), now=NOW)
    assert not play_history.record(ALICE, listen(), now=NOW + 5)
    assert play_history.summary(ALICE, now=NOW + 5)["total"] == 1


def test_the_same_song_again_later_counts_again():
    play_history.record(ALICE, listen(), now=NOW)
    assert play_history.record(ALICE, listen(), now=NOW + 60)
    assert play_history.summary(ALICE, now=NOW + 60)["total"] == 2


def test_another_song_right_after_counts():
    play_history.record(ALICE, listen("a"), now=NOW)
    assert play_history.record(ALICE, listen("b"), now=NOW + 1)


def test_two_accounts_playing_one_song_at_once_both_count():
    play_history.record(ALICE, listen(), now=NOW)
    assert play_history.record(BOB, listen(), now=NOW)


def test_concurrent_appends_lose_nothing():
    def write(start: int) -> None:
        for i in range(50):
            play_history.record(ALICE, listen(f"{start}-{i}"), now=NOW + i)

    threads = [threading.Thread(target=write, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert play_history.summary(ALICE, now=NOW)["total"] == 400


def test_an_unwritable_log_returns_false_instead_of_raising():
    with patch("core.play_history.sqlite3.connect", side_effect=sqlite3.Error("disk full")):
        assert play_history.record(ALICE, listen(), now=NOW) is False


def test_a_failed_write_does_not_count_as_the_play_having_happened():
    with patch("core.play_history.sqlite3.connect", side_effect=sqlite3.Error("disk full")):
        play_history.record(ALICE, listen(), now=NOW)
    assert play_history.record(ALICE, listen(), now=NOW + 1)


def test_an_unreadable_log_is_an_empty_summary():
    play_history.record(ALICE, listen(), now=NOW)
    with patch("core.play_history.sqlite3.connect", side_effect=sqlite3.Error("locked")):
        assert play_history.summary(ALICE, now=NOW)["total"] == 0


def test_every_listen_has_its_own_id():
    play_history.record(ALICE, listen("a"), now=NOW)
    play_history.record(ALICE, listen("b"), now=NOW + 1)
    ids = {row["id"] for row in play_history._read_listens(ALICE)}
    assert len(ids) == 2 and all(ids)


def test_a_play_keeps_everything_it_was_recorded_with():
    details = {"album": "Album", "album_id": "a1", "genre": "Pop", "duration": 180.5}
    play_history.record(ALICE, listen("a", **details), now=NOW)
    stored = play_history._read_listens(ALICE)[0]
    assert {key: stored[key] for key in details} == details
    assert stored["title"] == "Title a"


# ── the plain files from before the database ─────────────────────────────


def old_folder(tmp_path, name: str, identity: Account | None, meta=None, **files) -> None:
    folder = tmp_path / name
    folder.mkdir()
    owner = {"identity": identity._asdict()} if identity else {}
    (folder / "meta.json").write_text(json.dumps({**owner, **(meta or {})}), encoding="utf-8")
    for filename, text in files.items():
        (folder / f"{filename}.jsonl").write_text(text, encoding="utf-8")


def old_line(ts: int, **fields) -> str:
    return json.dumps({"ts": ts, "source": "beacon", **fields}) + "\n"


def test_old_logs_are_taken_in_with_their_state(tmp_path):
    old_folder(
        tmp_path,
        "a1",
        ALICE,
        meta={"import": {"status": "done", "source": "lastfm"}, "milestones": {"plays": 1000}},
        listens=old_line(NOW, song_id="s", title="Mine"),
        imported=old_line(NOW - 50, title="Old", source="lastfm"),
    )
    summary = play_history.summary(ALICE, now=NOW)
    assert summary["timestamps"] == [NOW - 50, NOW]
    assert summary["live_since"] == NOW
    assert summary["recent_plays"] == {"s": 1}
    assert play_history.import_state(ALICE)["source"] == "lastfm"
    assert play_history.milestones(ALICE) == {"plays": 1000}


def test_old_logs_stay_with_their_own_account(tmp_path):
    old_folder(tmp_path, "a1", ALICE, listens=old_line(NOW))
    old_folder(tmp_path, "b1", BOB, listens=old_line(NOW) * 2)
    assert play_history.summary(ALICE, now=NOW)["total"] == 1
    assert play_history.summary(BOB, now=NOW)["total"] == 2


def test_a_broken_old_line_costs_only_itself(tmp_path):
    broken = '{"ts": 12\n[1, 2]\n{"no_ts": true}\n'
    old_folder(tmp_path, "a1", ALICE, listens=old_line(NOW) + broken + old_line(NOW))
    assert play_history.summary(ALICE, now=NOW)["total"] == 2


def test_an_old_folder_without_an_owner_is_passed_over(tmp_path):
    old_folder(tmp_path, "nobody", None, listens=old_line(NOW))
    old_folder(tmp_path, "a1", ALICE, listens=old_line(NOW))
    assert play_history.summary(ALICE, now=NOW)["total"] == 1


def test_old_logs_are_taken_in_only_once(tmp_path):
    old_folder(tmp_path, "a1", ALICE, listens=old_line(NOW))
    play_history.summary(ALICE, now=NOW)
    assert play_history.summary(ALICE, now=NOW)["total"] == 1


def test_an_interrupted_takeover_starts_over(tmp_path):
    old_folder(tmp_path, "a1", ALICE, listens=old_line(NOW))
    with patch.object(play_history, "_write_account_field", side_effect=sqlite3.Error("gone")):
        assert play_history.summary(ALICE, now=NOW)["total"] == 0
    assert play_history.summary(ALICE, now=NOW)["total"] == 1


# ── the summary ──────────────────────────────────────────────────────────


def test_timestamps_are_sorted_across_own_and_imported():
    play_history.record(ALICE, listen(), now=NOW)
    play_history.replace_imported(ALICE, "lastfm", [imported(NOW - 10), imported(NOW - 90)])
    assert play_history.summary(ALICE, now=NOW)["timestamps"] == [NOW - 90, NOW - 10, NOW]


def test_recent_plays_cover_30_days_of_beacons_own_entries():
    play_history.record(ALICE, listen("old"), now=NOW - 31 * DAY)
    play_history.record(ALICE, listen("new"), now=NOW - 29 * DAY)
    play_history.replace_imported(ALICE, "lastfm", [imported(NOW - 40 * DAY)])
    assert play_history.summary(ALICE, now=NOW)["recent_plays"] == {"new": 1}


def test_charts_rank_by_plays():
    for i in range(3):
        play_history.record(ALICE, listen("a", title="A"), now=NOW + i * 100)
    play_history.record(ALICE, listen("b", title="B"), now=NOW + 500)
    songs = play_history.summary(ALICE, now=NOW)["top"]["songs"]
    assert [(s["label"], s["value"]) for s in songs] == [("A", 3), ("B", 1)]


def test_charts_group_differently_spelled_names():
    play_history.record(ALICE, listen("a", title="Café!", artist="ÄRA"), now=NOW)
    play_history.replace_imported(ALICE, "lastfm", [imported(NOW - 5, title="cafe", artist="Ära")])
    songs = play_history.summary(ALICE, now=NOW)["top"]["songs"]
    assert [s["value"] for s in songs] == [2]


def test_a_chart_group_is_described_by_beacons_entry_when_it_has_one():
    play_history.record(
        ALICE,
        listen("a", title="T", album="Al", album_id="alb", cover_art_id="cov"),
        now=NOW,
    )
    play_history.replace_imported(ALICE, "lastfm", [imported(NOW - 5, title="T")])
    album = play_history.summary(ALICE, now=NOW)["top"]["songs"][0]
    assert album["album_id"] == "alb"
    assert album["cover_art_id"] == "cov"


def test_charts_leave_out_entries_with_nothing_to_group_by():
    play_history.record(ALICE, listen("a", genre=""), now=NOW)
    assert play_history.summary(ALICE, now=NOW)["top"]["genres"] == []


def test_period_charts_only_count_plays_inside_the_window():
    play_history.record(ALICE, listen("old", title="Old"), now=NOW - 10 * DAY)
    play_history.record(ALICE, listen("new", title="New"), now=NOW - 1 * DAY)

    week = play_history.period_charts(ALICE, "week", now=NOW)
    assert week["period"] == "week"
    assert week["total"] == 1
    assert [(song["label"], song["value"]) for song in week["top"]["songs"]] == [("New", 1)]

    month = play_history.period_charts(ALICE, "month", now=NOW)
    assert month["total"] == 2


def test_period_charts_include_a_play_exactly_on_the_cutoff():
    play_history.record(ALICE, listen(), now=NOW - 7 * DAY)
    assert play_history.period_charts(ALICE, "week", now=NOW)["total"] == 1
    assert play_history.period_charts(ALICE, "week", now=NOW + 1)["total"] == 0


def test_period_charts_all_time_counts_everything():
    play_history.record(ALICE, listen(), now=NOW - 400 * DAY)
    assert play_history.period_charts(ALICE, "all_time", now=NOW)["total"] == 1


# ── milestones ───────────────────────────────────────────────────────────


def test_milestones_are_none_before_the_first_visit():
    assert play_history.milestones(ALICE) is None


def test_milestones_only_go_up():
    play_history.save_milestones(ALICE, {"plays": 2000, "hours": 100, "streak": 7})
    play_history.save_milestones(ALICE, {"plays": 1000, "hours": 200, "streak": 7})
    assert play_history.milestones(ALICE) == {"plays": 2000, "hours": 200, "streak": 7}


# ── the import's files ───────────────────────────────────────────────────


def test_an_import_keeps_only_what_is_older_than_the_first_own_entry():
    play_history.record(ALICE, listen(), now=NOW)
    kept = play_history.replace_imported(
        ALICE, "lastfm", [imported(NOW - 1), imported(NOW), imported(NOW + 1)]
    )
    assert kept == 1
    assert play_history.summary(ALICE, now=NOW)["timestamps"] == [NOW - 1, NOW]


def test_an_import_keeps_everything_without_any_own_entry():
    assert play_history.replace_imported(ALICE, "lastfm", [imported(1), imported(2)]) == 2


def test_an_import_forgets_what_was_seen_so_old_plays_are_not_celebrated():
    play_history.save_milestones(ALICE, {"plays": 1000, "hours": 0, "streak": 0})
    play_history.replace_imported(ALICE, "lastfm", [])
    assert play_history.milestones(ALICE) is None


def test_an_import_replaces_the_previous_one():
    play_history.replace_imported(ALICE, "lastfm", [imported(1), imported(2)])
    play_history.replace_imported(ALICE, "listenbrainz", [imported(3)])
    assert play_history.summary(ALICE, now=NOW)["timestamps"] == [3]


def test_an_import_records_its_source_on_each_listen():
    play_history.replace_imported(ALICE, "lastfm", [imported(1)])
    assert play_history._read_listens(ALICE)[0]["source"] == "lastfm"


def test_a_failed_import_write_leaves_the_previous_year():
    play_history.replace_imported(ALICE, "lastfm", [imported(1)])
    with (
        patch.object(play_history, "_write_account_field", side_effect=sqlite3.Error("full")),
        pytest.raises(sqlite3.Error),
    ):
        play_history.replace_imported(ALICE, "listenbrainz", [imported(2), imported(3)])
    assert play_history.summary(ALICE, now=NOW)["timestamps"] == [1]


def test_an_import_leaves_beacons_own_plays_alone():
    play_history.record(ALICE, listen(), now=NOW)
    play_history.replace_imported(ALICE, "lastfm", [imported(1)])
    play_history.replace_imported(ALICE, "listenbrainz", [imported(2)])
    assert play_history.summary(ALICE, now=NOW)["timestamps"] == [2, NOW]


def test_import_state_starts_at_none():
    assert play_history.import_state(ALICE) == {"status": "none"}


# ── reading the services ─────────────────────────────────────────────────


def lastfm_page(entries, page, total) -> dict:
    return {
        "recenttracks": {
            "track": entries,
            "@attr": {"page": str(page), "totalPages": str(total)},
        }
    }


def lastfm_track(ts, title="T") -> dict:
    return {
        "name": title,
        "artist": {"#text": "Ar"},
        "album": {"#text": "Al"},
        "date": {"uts": str(ts)},
    }


async def test_lastfm_pages_to_the_end_and_skips_what_is_playing_now():
    now_playing = {"name": "Now", "artist": {"#text": "Ar"}, "@attr": {"nowplaying": "true"}}
    pages = [
        lastfm_page([now_playing, lastfm_track(20)], 1, 2),
        lastfm_page([lastfm_track(10)], 2, 2),
    ]
    with (
        patch.object(lastfm, "_get", AsyncMock(side_effect=pages)) as get,
        patch.object(lastfm, "_HISTORY_PACING", 0),
    ):
        seen: list[int] = []
        listens = await lastfm.get_recent_listens("x", 5, 30, seen.append)
    assert [entry["ts"] for entry in listens] == [20, 10]
    assert listens[0] == {"ts": 20, "title": "T", "artist": "Ar", "album": "Al"}
    assert seen == [1, 2]
    assert get.call_args_list[0].kwargs["from"] == 5
    assert get.call_args_list[0].kwargs["to"] == 30


async def test_lastfm_copes_with_a_single_bare_track():
    page = {"recenttracks": {"track": lastfm_track(20), "@attr": {"page": "1", "totalPages": "1"}}}
    with patch.object(lastfm, "_get", AsyncMock(return_value=page)):
        listens = await lastfm.get_recent_listens("x", 5, 30, lambda _: None)
    assert [entry["ts"] for entry in listens] == [20]


def brainz_page(*stamps) -> dict:
    return {
        "payload": {
            "listens": [
                {
                    "listened_at": ts,
                    "track_metadata": {
                        "track_name": "T",
                        "artist_name": "Ar",
                        "release_name": "Al",
                    },
                }
                for ts in stamps
            ]
        }
    }


async def test_listenbrainz_walks_back_until_the_start_of_the_range():
    pages = [brainz_page(100, 90), brainz_page(80, 40, 30)]
    with patch.object(listenbrainz, "_request", AsyncMock(side_effect=pages)) as request:
        listens = await listenbrainz.get_listens("x", 50, 110, lambda _: None)
    assert [entry["ts"] for entry in listens] == [100, 90, 80]
    assert [call.kwargs["params"]["max_ts"] for call in request.call_args_list] == [110, 90]


async def test_listenbrainz_stops_when_a_page_is_empty():
    with patch.object(listenbrainz, "_request", AsyncMock(return_value=brainz_page())):
        assert await listenbrainz.get_listens("x", 50, 110, lambda _: None) == []


async def test_listenbrainz_cannot_loop_on_a_page_that_does_not_move_back():
    page = brainz_page(110)
    with patch.object(listenbrainz, "_request", AsyncMock(return_value=page)) as request:
        await listenbrainz.get_listens("x", 50, 110, lambda _: None)
    assert request.await_count == 1


async def test_listenbrainz_escapes_the_name_in_the_path():
    with patch.object(listenbrainz, "_request", AsyncMock(return_value=brainz_page())) as request:
        await listenbrainz.get_listens("a/b c", 50, 110, lambda _: None)
    assert request.call_args.args[1] == "/1/user/a%2Fb%20c/listens"


# ── running the import ───────────────────────────────────────────────────


async def _finish(account: Account) -> None:
    await play_history_import._runs[account].task


async def test_a_finished_import_is_stored_and_not_run_again():
    fetch = AsyncMock(return_value=[imported(5)])
    with patch.object(lastfm, "get_recent_listens", fetch):
        play_history_import.start(ALICE, "lastfm", "x", {"status": "none"})
        await _finish(ALICE)
        saved = play_history.import_state(ALICE)
        play_history_import.start(ALICE, "lastfm", "x", saved)
        await _finish(ALICE)
    assert saved == {"status": "done", "source": "lastfm"}
    assert fetch.await_count == 1
    assert play_history.summary(ALICE, now=NOW)["timestamps"] == [5]


async def test_a_finished_import_runs_again_when_asked_and_replaces_the_year():
    fetch = AsyncMock(side_effect=[[imported(5)], [imported(7), imported(9)]])
    with patch.object(lastfm, "get_recent_listens", fetch):
        play_history_import.start(ALICE, "lastfm", "x", {"status": "none"})
        await _finish(ALICE)
        saved = play_history.import_state(ALICE)
        play_history_import.start(ALICE, "lastfm", "x", saved, again=True)
        await _finish(ALICE)
    assert play_history.summary(ALICE, now=NOW)["timestamps"] == [7, 9]


async def test_a_failed_second_import_keeps_the_year_there_was():
    fetch = AsyncMock(side_effect=[[imported(5)], lastfm.LastfmError("down")])
    with patch.object(lastfm, "get_recent_listens", fetch):
        play_history_import.start(ALICE, "lastfm", "x", {"status": "none"})
        await _finish(ALICE)
        saved = play_history.import_state(ALICE)
        play_history_import.start(ALICE, "lastfm", "x", saved, again=True)
        await _finish(ALICE)
    assert play_history.import_state(ALICE)["status"] == "failed"
    assert play_history.summary(ALICE, now=NOW)["timestamps"] == [5]


async def test_an_import_already_running_is_not_started_twice_even_when_asked():
    release = asyncio.Event()

    async def slow(*_args):
        await release.wait()
        return []

    fetch = AsyncMock(side_effect=slow)
    with patch.object(lastfm, "get_recent_listens", fetch):
        play_history_import.start(ALICE, "lastfm", "x", {"status": "none"})
        play_history_import.start(ALICE, "lastfm", "x", {"status": "done"}, again=True)
        await asyncio.sleep(0)
        release.set()
        await _finish(ALICE)
    assert fetch.await_count == 1


async def test_the_source_decides_which_service_is_read():
    brainz = AsyncMock(return_value=[])
    fm = AsyncMock(return_value=[])
    with (
        patch.object(listenbrainz, "get_listens", brainz),
        patch.object(lastfm, "get_recent_listens", fm),
    ):
        play_history_import.start(ALICE, "listenbrainz", "x", {"status": "none"})
        await _finish(ALICE)
    assert brainz.await_count == 1
    assert fm.await_count == 0


async def test_a_second_start_while_running_does_nothing():
    release = asyncio.Event()

    async def slow(*_args):
        await release.wait()
        return []

    with patch.object(lastfm, "get_recent_listens", side_effect=slow) as fetch:
        play_history_import.start(ALICE, "lastfm", "x", {"status": "none"})
        await asyncio.sleep(0)
        play_history_import.start(ALICE, "lastfm", "x", {"status": "none"})
        assert play_history_import.status(ALICE, {"status": "none"})["status"] == "running"
        release.set()
        await _finish(ALICE)
    assert fetch.call_count == 1


async def test_a_failed_import_leaves_nothing_and_may_run_again():
    failing = AsyncMock(side_effect=lastfm.LastfmError("nope", not_found=True))
    with patch.object(lastfm, "get_recent_listens", failing):
        play_history_import.start(ALICE, "lastfm", "x", {"status": "none"})
        await _finish(ALICE)
    state = play_history.import_state(ALICE)
    assert state == {"status": "failed", "source": "lastfm", "error": "not_found"}
    assert play_history.summary(ALICE, now=NOW)["total"] == 0

    with patch.object(lastfm, "get_recent_listens", AsyncMock(return_value=[imported(5)])):
        play_history_import.start(ALICE, "lastfm", "x", state)
        await _finish(ALICE)
    assert play_history.import_state(ALICE)["status"] == "done"


async def test_an_upstream_failure_is_reported_as_unavailable():
    failing = AsyncMock(side_effect=listenbrainz.ListenbrainzError("down"))
    with patch.object(listenbrainz, "get_listens", failing):
        play_history_import.start(ALICE, "listenbrainz", "x", {"status": "none"})
        await _finish(ALICE)
    assert play_history.import_state(ALICE)["error"] == "unavailable"


# ── the routes ───────────────────────────────────────────────────────────


def test_routes_need_a_verified_session(client):
    assert client.get("/play-history/summary").status_code == 401
    assert client.get("/play-history/charts").status_code == 401
    assert client.post("/play-history", json=listen()).status_code == 401


def test_a_play_lands_in_the_sessions_account(client, signed_in):
    assert client.post("/play-history", json=listen()).json() == {"recorded": True}
    assert play_history.summary(ALICE)["total"] == 1
    assert client.get("/play-history/summary").json()["total"] == 1


def test_the_body_cannot_name_another_account(client, signed_in):
    client.post("/play-history", json={**listen(), "username": "bob"})
    assert play_history.summary(BOB)["total"] == 0


def test_a_session_without_a_name_has_no_log(client, signed_in):
    signed_in.account_username = ""
    assert client.post("/play-history", json=listen()).json() == {"recorded": False}
    assert client.get("/play-history/summary").json()["available"] is False
    assert client.get("/play-history/import").json() == {"status": "none"}


def test_a_listener_cannot_read_another_account(client, signed_in):
    play_history.record(BOB, listen())
    response = client.get("/play-history/summary", params={"username": "bob"})
    assert response.status_code == 403
    assert "timestamps" not in response.json()


def test_a_listener_can_name_themselves(client, signed_in):
    assert client.get("/play-history/summary", params={"username": "alice"}).status_code == 200


def test_a_listener_cannot_list_accounts(client, signed_in):
    assert client.get("/play-history/accounts").status_code == 403


def test_charts_are_read_for_a_period(client, signed_in):
    # The route reads the clock itself, so these are relative to the real
    # one rather than to the test's fixed NOW.
    now = int(time.time())
    play_history.record(ALICE, listen("old", title="Old"), now=now - 10 * DAY)
    play_history.record(ALICE, listen("new", title="New"), now=now - 1 * DAY)

    body = client.get("/play-history/charts", params={"period": "week"}).json()
    assert body["period"] == "week"
    assert body["total"] == 1
    assert [song["label"] for song in body["top"]["songs"]] == ["New"]


def test_charts_default_to_all_time(client, signed_in):
    play_history.record(ALICE, listen(), now=int(time.time()) - 400 * DAY)
    assert client.get("/play-history/charts").json()["total"] == 1


def test_an_unknown_period_is_refused(client, signed_in):
    assert client.get("/play-history/charts", params={"period": "decade"}).status_code == 422


def test_a_session_without_a_name_gets_empty_charts(client, signed_in):
    signed_in.account_username = ""
    body = client.get("/play-history/charts", params={"period": "week"}).json()
    assert body == {
        "period": "week",
        "total": 0,
        "top": {"songs": [], "artists": [], "albums": [], "genres": []},
    }


def test_a_listener_cannot_read_another_accounts_charts(client, signed_in):
    play_history.record(BOB, listen())
    response = client.get("/play-history/charts", params={"username": "bob"})
    assert response.status_code == 403


def test_an_admin_reads_another_accounts_charts(client, signed_in):
    signed_in.account_is_admin = True
    play_history.record(BOB, listen("a", title="Bobs song"), now=int(time.time()))
    with patch("core.cast_permissions.known_accounts", return_value=["alice", "bob"]):
        response = client.get("/play-history/charts", params={"username": "bob", "period": "month"})
    assert response.status_code == 200
    assert response.json()["top"]["songs"][0]["label"] == "Bobs song"


def test_an_admin_reads_another_account_on_their_server(client, signed_in):
    signed_in.account_is_admin = True
    play_history.record(BOB, listen())
    with patch("core.cast_permissions.known_accounts", return_value=["alice", "bob"]):
        response = client.get("/play-history/summary", params={"username": "bob"})
    assert response.status_code == 200
    assert response.json()["total"] == 1
    # Another account's milestones are nobody else's to celebrate.
    assert "milestones" not in response.json()


def test_an_admin_is_asked_about_their_own_server_only(client, signed_in):
    signed_in.account_is_admin = True
    with patch("core.cast_permissions.known_accounts", return_value=[]) as known:
        response = client.get("/play-history/summary", params={"username": "carol"})
    assert response.status_code == 404
    known.assert_called_once_with(ALICE.server_type, ALICE.server_url)


def test_an_admin_gets_the_accounts_sorted(client, signed_in):
    signed_in.account_is_admin = True
    with patch("core.cast_permissions.known_accounts", return_value=["bob", "Alice"]):
        assert client.get("/play-history/accounts").json() == {"accounts": ["Alice", "bob"]}


def test_a_client_without_the_step_does_not_lose_it(client, signed_in):
    body = {"plays": 1000, "hours": 0, "streak": 0}
    client.put("/play-history/milestones", json={**body, "records": 3})
    client.put("/play-history/milestones", json=body)
    assert client.get("/play-history/summary").json()["milestones"]["records"] == 3


def test_milestones_are_saved_for_the_session_and_returned(client, signed_in):
    body = {"plays": 1000, "hours": 100, "streak": 7, "records": 1}
    assert client.put("/play-history/milestones", json=body).status_code == 200
    assert client.get("/play-history/summary").json()["milestones"] == body
    assert play_history.milestones(BOB) is None


def test_lastfm_import_needs_the_installations_key(client, signed_in):
    with patch.object(lastfm, "is_configured", return_value=False):
        response = client.post("/play-history/import", json={"source": "lastfm", "username": "x"})
    assert response.status_code == 409


def test_an_unknown_source_is_refused(client, signed_in):
    response = client.post("/play-history/import", json={"source": "other", "username": "x"})
    assert response.status_code == 422


def test_starting_an_import_for_a_nameless_session_is_refused(client, signed_in):
    signed_in.account_username = ""
    response = client.post("/play-history/import", json={"source": "listenbrainz", "username": "x"})
    assert response.status_code == 409


def test_the_route_passes_on_a_request_to_import_again(client, signed_in):
    with patch.object(play_history_import, "start") as start:
        body = {"source": "listenbrainz", "username": "x", "again": True}
        assert client.post("/play-history/import", json=body).status_code == 200
    assert start.call_args.kwargs == {"again": True}


def test_import_runs_for_the_sessions_account(client, signed_in):
    with patch.object(listenbrainz, "get_listens", AsyncMock(return_value=[imported(5)])):
        response = client.post(
            "/play-history/import", json={"source": "listenbrainz", "username": "x"}
        )
        assert response.status_code == 200
        for _ in range(200):
            if client.get("/play-history/import").json()["status"] == "done":
                break
    assert play_history.summary(ALICE)["total"] == 1
    assert play_history.summary(BOB)["total"] == 0
