"""core/play_history_import.py - fills the listening year on the first visit.

Reads a year of a public Last.fm or ListenBrainz profile, once per account
unless the listener asks again, in the background: ListenBrainz alone allows one call a second, so it takes
longer than a request should stay open.

Everything is held in memory until the last page has arrived and then written
in one go (core/play_history.py), so a failure leaves no partial year.
"""

import asyncio
import logging
import time
from typing import NamedTuple

from core import lastfm, listenbrainz, play_history
from core.play_history import Account

logger = logging.getLogger("connect.play_history")

# The 53 weeks the listening year shows. ListenBrainz asks not to page through
# a whole history with this endpoint, and a bounded range is what it is for.
_WINDOW_SECONDS = 371 * 24 * 60 * 60


class _Run(NamedTuple):
    source: str
    task: asyncio.Task
    fetched: list[int]


_runs: dict[Account, _Run] = {}


def status(account: Account, saved: dict) -> dict:
    """`saved` is core/play_history.py's import_state(), read by the caller
    off the event loop."""
    run = _runs.get(account)
    if run and not run.task.done():
        return {"status": "running", "source": run.source, "fetched": run.fetched[0]}
    return saved


async def _fetch(source: str, username: str, since: int, until: int, on_page) -> list[dict]:
    fetch = lastfm.get_recent_listens if source == "lastfm" else listenbrainz.get_listens
    return await fetch(username, since, until, on_page)


async def _run(account: Account, source: str, username: str, fetched: list[int]) -> None:
    now = int(time.time())

    def on_page(count: int) -> None:
        fetched[0] = count

    try:
        listens = await _fetch(source, username, now - _WINDOW_SECONDS, now, on_page)
    except (lastfm.LastfmError, listenbrainz.ListenbrainzError) as e:
        logger.warning(f"[play-history] import from {source} failed: {e}")
        code = "not_found" if e.not_found else "unavailable"
        await asyncio.to_thread(play_history.mark_import_failed, account, source, code)
        return
    kept = await asyncio.to_thread(play_history.replace_imported, account, source, listens)
    logger.info(f"[play-history] imported {kept} listens from {source}")


def start(account: Account, source: str, username: str, saved: dict, again: bool = False) -> None:
    """Starts unless one is running or has already finished. A failed one may
    run again, and a finished one when the listener asks (`again`): what is
    there stays until the new year has arrived whole."""
    run = _runs.get(account)
    if (run and not run.task.done()) or (saved.get("status") == "done" and not again):
        return
    fetched = [0]
    task = asyncio.create_task(_run(account, source, username, fetched))
    _runs[account] = _Run(source, task, fetched)
