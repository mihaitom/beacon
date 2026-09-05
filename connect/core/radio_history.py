"""core/radio_history.py — the radio title log, kept across restarts.

SessionState.radio_title_history (core/session.py) records every ICY
StreamTitle a station has played, per station, for LyricsDrawer.vue to show
in place of the lyrics a radio station never has. In memory alone that log
is gone in two entirely routine situations, and in both of them the user
did nothing to throw it away: the session is reaped after
SESSION_IDLE_TIMEOUT of not listening (reap_once() removes the whole
SessionState), and the packaged desktop app spawns its own connect, so
every app launch starts from nothing. What the log is *for* — starting a
station and looking at what it played yesterday — needs it to outlive both.

One directory per session, one file per station inside it, so a title
arriving touches a single station's file rather than one document shared by
every station and every session; a file that ends up corrupt costs one
station's log rather than all of them. Persisted the same CONNECT_DATA_DIR
way as delivery/credentials.py and core/radio_stations.py, which survives
Electron app updates and Docker container recreation.

A station's file is JSON Lines — a header naming the station, then one
object per title — and a new title is *appended* rather than written by
rebuilding the file. That matters because these logs are deliberately long
(see core/session.py's own cap): rewriting a whole file per title costs
more the more there is to keep, which is exactly backwards for something
whose value is in keeping a lot. Appending costs the same at ten entries as
at ten thousand, and a crash mid-write loses the one line being added
rather than the file. Trimming back to the cap is the only whole-file
rewrite and happens once per _TRIM_FACTOR-worth of growth.

The session id is hashed into the directory name for the same reason
core/account_settings.py hashes its account key: nothing here needs to read
an identity back out, only to land the same session on the same directory
every time.

Deliberately not a *shared* log across sessions, even though two people
listening to one station would record the same titles: an entry says "this
was playing while I was listening", which is a record of when somebody
listened, not just of what a station broadcast.
"""

import hashlib
import json
import logging
import os
import time

logger = logging.getLogger("connect.radio_history")

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_DIR = os.path.join(_DATA_DIR, "radio-history")

# How long a session's stored log is kept after the last time anything was
# written to it. Bounds a directory that would otherwise grow with every
# session that ever existed — a session id changes with the login it is
# derived from, so old ones are never revisited.
_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

# How many stations one session keeps *on disk*, least recently played
# dropped first. Higher than the number core/session.py holds in memory at
# once, since a stored station costs nothing until it is played again — but
# not unbounded, because every station ever tried once would otherwise keep
# a file of its own forever.
_MAX_STATIONS = 50

# How far past the cap a file is allowed to grow before it is rewritten
# back down to it. The whole point of appending is not to touch the rest of
# the file per title; trimming on every append would give that straight
# back. At 2, a station pays one rewrite per cap-worth of new titles, and
# the file never holds more than twice what it will hand back.
_TRIM_FACTOR = 2


def _session_dir(session_id: str) -> str:
    digest = hashlib.sha256(session_id.encode()).hexdigest()[:24]
    return os.path.join(_DIR, digest)


def _station_path(session_id: str, url: str) -> str:
    digest = hashlib.sha256(url.encode()).hexdigest()[:32]
    return os.path.join(_session_dir(session_id), f"{digest}.jsonl")


def _parse(lines: list[str]) -> list[dict]:
    """The entry objects among `lines`, oldest first. Anything else — the
    header, a line half-written when the process died, something
    hand-edited — is skipped rather than fatal: one lost title is not worth
    giving up a log of thousands over."""
    entries = []
    for line in lines:
        try:
            parsed = json.loads(line)
            entries.append({"title": str(parsed["title"]), "at": float(parsed["at"])})
        except (ValueError, KeyError, TypeError):
            continue
    return entries


def load_station(session_id: str, url: str, max_entries: int) -> list[dict]:
    """One station's stored titles, oldest first, at most `max_entries` of
    them (the newest, when the file still holds more — see _TRIM_FACTOR).

    Per station rather than per session on purpose: a log this long is
    worth holding in memory only for the station somebody is actually
    listening to, not for all fifty they have ever tried.

    Empty for a station that has never stored anything, which is also what
    any unreadable state degrades to: a log that cannot be read back is a
    log that starts empty, never a station that fails to play."""
    prune()
    try:
        with open(_station_path(session_id, url), encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return []
    except OSError as e:
        logger.warning(f"[radio-history] reading {url} failed: {e}")
        return []
    return _parse(lines)[-max_entries:]


def append(session_id: str, url: str, entry: dict, max_entries: int) -> None:
    """Adds one title to a station's log, trimming the file back to
    `max_entries` once it has grown _TRIM_FACTOR times past it.

    Never raises: a log that cannot be written is a log that does not
    survive a restart, not a station that fails to play."""
    path = _station_path(session_id, url)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        new_file = not os.path.exists(path)
        with open(path, "a", encoding="utf-8") as f:
            if new_file:
                # Names the station this file belongs to. Nothing reads it
                # back (the filename's hash is what addresses it), but a
                # directory of hashes nobody can identify is a bad thing to
                # hand somebody looking at their own data — including me,
                # debugging this.
                f.write(json.dumps({"url": url}) + "\n")
            f.write(json.dumps(entry) + "\n")
    except OSError as e:
        logger.warning(f"[radio-history] appending to {url} failed: {e}")
        return
    _trim(path, url, max_entries)


def _trim(path: str, url: str, max_entries: int) -> None:
    """Rewrites `path` down to its newest `max_entries` titles, but only
    once it holds _TRIM_FACTOR times that many. Through a temporary file
    and a rename, so a reader only ever sees a whole log."""
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
        if len(lines) <= max_entries * _TRIM_FACTOR:
            return
        entries = _parse(lines)[-max_entries:]
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps({"url": url}) + "\n")
            f.writelines(json.dumps(entry) + "\n" for entry in entries)
        os.replace(tmp, path)
    except OSError as e:
        logger.warning(f"[radio-history] trimming {url} failed: {e}")


def prune() -> None:
    """Drops session directories nothing has written to in
    _MAX_AGE_SECONDS, and within a surviving one the stations beyond
    _MAX_STATIONS, least recently played first.

    Cheap enough to run on every load_station(): the outer directory holds
    one entry per session that has listened to radio, and a session's own
    holds one small file per station."""
    cutoff = time.time() - _MAX_AGE_SECONDS
    try:
        names = os.listdir(_DIR)
    except OSError:
        return
    for name in names:
        directory = os.path.join(_DIR, name)
        try:
            files = sorted(
                (os.path.getmtime(os.path.join(directory, f)), os.path.join(directory, f))
                for f in os.listdir(directory)
            )
            if not files or files[-1][0] < cutoff:
                for _, path in files:
                    os.remove(path)
                os.rmdir(directory)
                logger.info(f"[radio-history] dropped stale session log {name}")
                continue
            for _, path in files[: max(0, len(files) - _MAX_STATIONS)]:
                os.remove(path)
        except (NotADirectoryError, FileNotFoundError):
            continue
        except OSError as e:
            logger.info(f"[radio-history] pruning {name} failed: {e}")
