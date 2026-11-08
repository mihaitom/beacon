"""core/now_playing.py - what an account is listening to, for its own apps.

A field list of its own rather than build_status_dict(): that one carries the
queue and stream diagnostics, and its cover_art_url has the media server's
credentials in the query string on Subsonic.
"""

import time

from core.play_history import Account
from core.session import SessionState, compute_position, registry
from core.state import TEST_TONE_TRACK_ID, list_target_pairs

NOTHING: dict = {"playing": False}

# The position an app was last told, carried forward, is allowed to be this
# far off before it counts as somebody having seeked.
_SEEK_TOLERANCE_SECONDS = 2.0

_POSITION_FIELDS = ("position", "at")


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


def _cast_of(account: Account) -> SessionState | None:
    """One that is playing before one that is paused, then the last started."""
    casts = [session for session in registry.all() if _is_casting(session, account)]
    return max(
        casts,
        key=lambda s: (not s.state.clock.is_paused, s.state.clock.play_start_time or 0.0),
        default=None,
    )


def current(account: Account, now: float | None = None) -> dict:
    session = _cast_of(account)
    if session is None:
        return NOTHING
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
        "at": round(time.time() if now is None else now, 3),
    }


def differs(shown: dict, latest: dict) -> bool:
    """Whether an app following along has to hear about `latest`."""
    if any(
        shown.get(field) != latest.get(field)
        for field in {*shown, *latest}
        if field not in _POSITION_FIELDS
    ):
        return True
    if shown.get("position") is None or latest.get("position") is None:
        return False
    moved = 0.0 if shown["paused"] else latest["at"] - shown["at"]
    return abs(shown["position"] + moved - latest["position"]) > _SEEK_TOLERANCE_SECONDS


def cover_of(account: Account) -> tuple[object, str] | None:
    """The media client and cover id of the song being cast, if it has one."""
    session = _cast_of(account)
    if session is None or session.state.current_track is None:
        return None
    cover_id = session.state.current_track.cover_art_id
    return (session.media, cover_id) if cover_id else None
