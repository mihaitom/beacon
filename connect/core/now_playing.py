"""core/now_playing.py - what an account is listening to, for its own apps.

A cast is read from its session. What a browser or a desktop app plays by
itself is known only from what it reports (routes/now_playing.py), and counts
as gone once the reports stop.

A field list of its own rather than build_status_dict(): that one carries the
queue and stream diagnostics, and its cover_art_url has the media server's
credentials in the query string on Subsonic.
"""

import threading
import time
from collections.abc import Callable
from typing import NamedTuple

from core.play_history import Account
from core.session import SessionState, compute_position, registry
from core.state import TEST_TONE_TRACK_ID, list_target_pairs

NOTHING: dict = {"playing": False}

# The position an app was last told, carried forward, is allowed to be this
# far off before it counts as somebody having seeked.
_SEEK_TOLERANCE_SECONDS = 2.0

_POSITION_FIELDS = ("position", "at")

# A window reports every 30 seconds. Long enough for a lost request or two,
# short enough that a closed laptop stops counting as playing.
REPORT_TTL_SECONDS = 90.0

_SONG_FIELDS = ("id", "title", "artist", "album", "duration")


class _Report(NamedTuple):
    account: Account
    report: dict
    at: float
    started: float


_reports: dict[str, _Report] = {}
# Written from worker threads, read from those and from the event loop.
_reports_lock = threading.Lock()


def _is_casting(session: SessionState, account: Account) -> bool:
    st = session.state
    if account != (
        session.account_server_type,
        session.account_server_url,
        session.account_username,
    ):
        return False
    if not st.is_streaming or st.track_ended or st.preview is not None:
        return False
    if not list_target_pairs(st.active_delivery):
        return False
    if st.current_track is not None:
        return st.current_track.id != TEST_TONE_TRACK_ID
    return st.radio_info is not None


def audible_cast(account: Account) -> SessionState | None:
    """The account's cast an app steers: what can be heard before what is
    paused, then the one that started last - as current() ranks them."""
    casts = [session for session in registry.all() if _is_casting(session, account)]
    if not casts:
        return None
    return max(
        casts,
        key=lambda session: (
            not session.state.clock.is_paused,
            session.state.clock.play_start_time or 0.0,
        ),
    )


def store_report(source: str, account: Account, report: dict, now: float | None = None) -> None:
    now = time.time() if now is None else now
    with _reports_lock:
        for key in [key for key, kept in _reports.items() if now - kept.at > REPORT_TTL_SECONDS]:
            del _reports[key]
        before = _reports.get(source)
        same = before is not None and _subject(before.report) == _subject(report)
        _reports[source] = _Report(account, report, now, before.started if same else now)


def forget_report(source: str) -> None:
    with _reports_lock:
        _reports.pop(source, None)


def _subject(report: dict) -> object:
    return report["song"]["id"] if report["song"] else report["radio"]["station"]


def _candidates(account: Account, now: float) -> list[tuple[tuple, SessionState | _Report]]:
    """Each with what it is ranked by: what can be heard before what is
    paused, then a cast before a device playing by itself, then the newest."""
    with _reports_lock:
        reports = list(_reports.values())
    ranked: list[tuple[tuple, SessionState | _Report]] = [
        (
            (not session.state.clock.is_paused, True, session.state.clock.play_start_time or 0.0),
            session,
        )
        for session in registry.all()
        if _is_casting(session, account)
    ]
    ranked += [
        ((not kept.report["paused"], bool(kept.report["devices"]), kept.started), kept)
        for kept in reports
        if kept.account == account and now - kept.at <= REPORT_TTL_SECONDS
    ]
    return ranked


def _best(account: Account, now: float) -> SessionState | _Report | None:
    ranked = _candidates(account, now)
    return max(ranked, key=lambda entry: entry[0])[1] if ranked else None


def _from_session(session: SessionState, now: float) -> dict:
    st = session.state
    track = st.current_track
    return {
        "playing": True,
        "paused": st.clock.is_paused,
        "kind": "song" if track is not None else "radio",
        "source": "cast",
        "devices": [name for _, name in list_target_pairs(st.active_delivery)],
        "song": None
        if track is None
        else {
            "id": track.id,
            "title": track.title,
            "artist": track.artist,
            "album": track.album,
            "duration": track.duration,
        },
        "radio": None
        if track is not None
        else {"station": st.radio_info["title"], "title": session.radio_title},
        "position": None if track is None else round(compute_position(session), 3),
        "at": round(now, 3),
    }


def _from_report(kept: _Report, now: float) -> dict:
    report = kept.report
    song = report["song"]
    position = report["position"]
    if song is None:
        position = None
    elif position is not None and not report["paused"]:
        position = min(position + now - kept.at, song["duration"] or float("inf"))
    return {
        "playing": True,
        "paused": report["paused"],
        "kind": "song" if song else "radio",
        "source": "cast" if report["devices"] else "local",
        "devices": report["devices"],
        "song": None if song is None else {k: song[k] for k in _SONG_FIELDS},
        "radio": report["radio"],
        "position": None if position is None else round(position, 3),
        "at": round(now, 3),
    }


def current(account: Account, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    best = _best(account, now)
    if best is None:
        return NOTHING
    return _from_report(best, now) if isinstance(best, _Report) else _from_session(best, now)


def _paused(state: dict) -> bool:
    return state["paused"]


def differs(shown: dict, latest: dict, paused: Callable[[dict], bool] = _paused) -> bool:
    """Whether an app following along has to hear about `latest`. `paused`
    reads a state's pause, for answers spelling it differently (/player)."""
    if any(
        shown.get(field) != latest.get(field)
        for field in {*shown, *latest}
        if field not in _POSITION_FIELDS
    ):
        return True
    if shown.get("position") is None or latest.get("position") is None:
        return False
    moved = 0.0 if paused(shown) else latest["at"] - shown["at"]
    return abs(shown["position"] + moved - latest["position"]) > _SEEK_TOLERANCE_SECONDS


def _session_of(account: Account) -> SessionState | None:
    """Any signed-in session of the account: the cover is the media server's,
    and for what a desktop reports there is no other way to reach it."""
    for session in registry.all():
        if account == (
            session.account_server_type,
            session.account_server_url,
            session.account_username,
        ):
            return session
    return None


def cover_of(account: Account, now: float | None = None) -> tuple[object, str] | None:
    """The media client and cover id of the song playing now, if it has one."""
    best = _best(account, time.time() if now is None else now)
    if isinstance(best, _Report):
        song = best.report["song"]
        session = _session_of(account)
        return (
            (session.media, song["cover_art_id"])
            if song and session and song["cover_art_id"]
            else None
        )
    if best is None or best.state.current_track is None:
        return None
    cover_id = best.state.current_track.cover_art_id
    return (best.media, cover_id) if cover_id else None
