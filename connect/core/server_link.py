"""core/server_link.py - a desktop app's pairing with a Beacon server.

The desktop keeps writing locally, so playing never waits for the network.
What the server has not acknowledged goes out from a background task, and
reading asks the server first and falls back to the local copy.

One link per installation, belonging to the account that made it. A desktop
can have held other logins, and their plays and settings never leave here.

The file is plain text, mode 0600, for the reason in core/api_keys.py. The key
in it never goes back to the renderer.

Docker installs have no use for this and refuse it (BEACON_HOSTED, set in
start.sh): the URL comes from a signed-in listener, and connect would be
making requests to wherever one of them pointed it.
"""

import asyncio
import ipaddress
import json
import logging
import os
import socket
import threading
import time
from urllib.parse import urlsplit

import httpx

from core import account_settings, api_keys, lyrics_offsets, play_history
from core.account_settings import LINKED_FIELDS
from core.paths import data_dir
from core.play_history import Account

logger = logging.getLogger("connect.server_link")

AVAILABLE = not os.getenv("BEACON_HOSTED")

_DATA_DIR = data_dir()
_FILENAME = "server_link.json"

KEY_HEADER = "X-Beacon-Device-Key"
INVALID_KEY_DETAIL = "Invalid device key"
# What a key needs to be a desktop app's: core/device_keys.py has the others.
SYNC_SCOPE = "sync"

CONNECTED = "connected"
WRONG_KEY = "wrong_key"
UNREACHABLE = "unreachable"
SERVER_TOO_OLD = "server_too_old"
# A login page or forward auth answered instead of Beacon.
BLOCKED = "blocked"
OTHER_ACCOUNT = "other_account"
INVALID_URL = "invalid_url"
INSECURE_URL = "insecure_url"

_PENDING_FIELDS = ("pending_settings", "pending_milestones", "pending_lyrics_offsets")

_BATCH_SIZE = 500
_OFFSET_BATCH_SIZE = 500
IDLE_SECONDS = 300.0
_BACKOFF_BASE_SECONDS = 30.0
_BACKOFF_MAX_SECONDS = 3600.0

# A renderer waits on the settings at login, so a server that has gone
# quiet must not hold that up for long.
_SETTINGS_TIMEOUT = httpx.Timeout(3.0)
_TIMEOUT = httpx.Timeout(15.0, connect=3.0)

_lock = threading.Lock()
_transport: httpx.BaseTransport | None = None
_state = CONNECTED
_failures = 0
_loop: asyncio.AbstractEventLoop | None = None
_wake_event: asyncio.Event | None = None


class LinkError(Exception):
    def __init__(self, state: str):
        super().__init__(state)
        self.state = state


def _path() -> str:
    return os.path.join(_DATA_DIR, _FILENAME)


def _is_well_formed(link: object) -> bool:
    """A file edited by hand is no pairing, and everything that reads one can
    then rely on these."""
    if not isinstance(link, dict):
        return False
    account = link.get("account")
    identity = link.get("settings_identity")
    return (
        isinstance(link.get("url"), str)
        and isinstance(link.get("key"), str)
        and isinstance(account, dict)
        and set(account) == set(Account._fields)
        and all(isinstance(value, str) for value in account.values())
        and (
            identity is None
            or (
                isinstance(identity, list)
                and len(identity) == 3
                and all(isinstance(part, str) for part in identity)
            )
        )
        and all(isinstance(link.get(field, {}), dict) for field in _PENDING_FIELDS)
    )


def _read() -> dict | None:
    try:
        with open(_path(), encoding="utf-8") as f:
            link = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        logger.warning(f"[server-link] Could not read the pairing: {e}")
        return None
    if not _is_well_formed(link):
        logger.warning("[server-link] Ignoring a pairing file of the wrong shape")
        return None
    return link


def _write(link: dict) -> None:
    tmp = f"{_path()}.tmp"
    os.makedirs(_DATA_DIR, exist_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(link, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, _path())


def _note(state: str) -> None:
    global _state, _failures
    _state = state
    _failures = 0 if state == CONNECTED else _failures + 1


def _note_answered() -> None:
    """A pull got through, so the state a failed pass left is out of date. A
    pass finds out whether sending works as well."""
    if _state != CONNECTED:
        _note(CONNECTED)
        wake()


def _is_private_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    return bool(infos) and all(
        ipaddress.ip_address(str(info[4][0]).split("%")[0]).is_private for info in infos
    )


def clean_url(url: str) -> str:
    """Raises LinkError for anything but plain http(s), and for http to a
    public address: the key and a listening history would cross it readable."""
    url = url.strip().rstrip("/")
    try:
        parts = urlsplit(url)
        host = parts.hostname
        # Only reading it checks it.
        _ = parts.port
    except ValueError as e:
        raise LinkError(INVALID_URL) from e
    # A ? or # would swallow the path that gets appended to this.
    if (
        parts.scheme not in ("http", "https")
        or not host
        or parts.username
        or parts.password
        or "?" in url
        or "#" in url
    ):
        raise LinkError(INVALID_URL)
    if parts.scheme == "http" and not _is_private_host(host):
        raise LinkError(INSECURE_URL)
    return url


def _call(
    url: str,
    key: str,
    method: str,
    path: str,
    body: dict | None = None,
    timeout: httpx.Timeout = _TIMEOUT,
) -> dict:
    """Raises LinkError saying what stands in the way."""
    # Redirects are not followed: with forward auth, one is the login page.
    try:
        with httpx.Client(transport=_transport, timeout=timeout, follow_redirects=False) as client:
            response = client.request(
                method, f"{url}/device-link{path}", headers={KEY_HEADER: key}, json=body
            )
    # UnicodeError: a host name that is not valid IDNA gets past httpx's own check.
    except (httpx.InvalidURL, UnicodeError) as e:
        raise LinkError(INVALID_URL) from e
    except httpx.HTTPError as e:
        raise LinkError(UNREACHABLE) from e
    if response.is_redirect:
        raise LinkError(BLOCKED)
    if response.status_code in (401, 403):
        detail = _detail(response)
        raise LinkError(WRONG_KEY if detail == INVALID_KEY_DETAIL else BLOCKED)
    if response.status_code == 404:
        raise LinkError(SERVER_TOO_OLD)
    if not response.is_success:
        raise LinkError(UNREACHABLE)
    try:
        answer = response.json()
    except ValueError as e:
        # An older Docker image answers unknown paths with the app's own
        # index.html, as a 200.
        raise LinkError(SERVER_TOO_OLD) from e
    if not isinstance(answer, dict):
        raise LinkError(SERVER_TOO_OLD)
    return answer


def _detail(response: httpx.Response) -> object:
    try:
        return response.json().get("detail")
    except (ValueError, AttributeError):
        return None


def _account_of(link: dict) -> Account:
    return Account(**link["account"])


def _identity_of(link: dict) -> tuple[str, str, str] | None:
    identity = link.get("settings_identity")
    return None if identity is None else tuple(identity)


def is_linked(account: Account | None) -> bool:
    link = _read()
    return link is not None and account is not None and _account_of(link) == account


def status(current: Account | None) -> dict:
    link = _read()
    if link is None:
        return {"available": AVAILABLE, "linked": False}
    account = _account_of(link)
    return {
        "available": AVAILABLE,
        "linked": True,
        "url": link["url"],
        "remote_username": link.get("remote_username", ""),
        "state": _state if current == account else OTHER_ACCOUNT,
        "last_sync_at": link.get("last_sync_at"),
        "unsent": play_history.count_unsent(account),
    }


def pair(
    account: Account, settings_identity: tuple[str, str, str] | None, url: str, key: str
) -> dict:
    """Checks the key against the server before anything is kept. Raises
    LinkError when that fails.

    Fields only this desktop knows go up, and for the rest the server wins,
    which is the rule every login applies anyway. Milestones do not go up:
    the plays they were counted against have not arrived yet, and the
    server's baseline is set after they have."""
    url = clean_url(url)
    info = _call(url, key, "GET", "/info")
    if info.get("device_link") != 1:
        raise LinkError(SERVER_TOO_OLD)
    # A key made for somebody's own app: refused here in those words, rather
    # than as the first sync call that it may not make.
    if SYNC_SCOPE not in info.get("scopes", [SYNC_SCOPE]):
        raise LinkError(WRONG_KEY)
    pending: dict = {}
    if settings_identity is not None:
        remote = _call(url, key, "GET", "/settings", timeout=_SETTINGS_TIMEOUT)
        local = account_settings.load(*settings_identity)
        pending = {k: v for k, v in local.items() if k in LINKED_FIELDS and k not in remote}
    remote_offsets = _call(url, key, "GET", "/lyrics-offsets").get("offsets") or {}
    pending_offsets = {
        song: seconds
        for song, seconds in lyrics_offsets.load(account).items()
        if song not in remote_offsets
    }
    play_history.forget_sent(account)
    with _lock:
        _write(
            {
                "url": url,
                "key": key,
                "account": account._asdict(),
                "settings_identity": settings_identity,
                "remote_username": info.get("username", ""),
                "pending_settings": pending,
                "pending_milestones": {},
                "pending_lyrics_offsets": pending_offsets,
                "backfill": True,
                "last_sync_at": None,
            }
        )
    _note(CONNECTED)
    logger.info(f"[server-link] Paired with {url}")
    wake(force=True)
    return status(account)


def unpair() -> None:
    """The local log and settings stay as they are."""
    with _lock:
        try:
            os.remove(_path())
        except FileNotFoundError:
            pass
    _forget_api_keys()
    _note(CONNECTED)


def note_settings_changed(identity: tuple[str, str, str], patch: dict) -> None:
    """Queues a change made on this desktop. No-op unless it is the paired
    account's."""
    with _lock:
        link = _read()
        if link is None or _identity_of(link) != identity:
            return
        changed = {k: v for k, v in patch.items() if k in LINKED_FIELDS}
        if not changed:
            return
        link.setdefault("pending_settings", {}).update(changed)
        _write(link)
    wake()


def pull_settings(identity: tuple[str, str, str]) -> dict | None:
    """The server's settings with this desktop's unsent changes on top, or
    None when the local copy has to answer."""
    link = _read()
    if link is None or _identity_of(link) != identity:
        return None
    try:
        remote = _call(link["url"], link["key"], "GET", "/settings", timeout=_SETTINGS_TIMEOUT)
    except LinkError as e:
        _note(e.state)
        return None
    _note_answered()
    settings = {k: v for k, v in remote.items() if k in LINKED_FIELDS}
    settings.update(link.get("pending_settings") or {})
    return settings


def note_milestones(account: Account, seen: dict) -> None:
    with _lock:
        link = _read()
        if link is None or _account_of(link) != account:
            return
        link["pending_milestones"] = seen
        _write(link)
    wake()


def summary_for(account: Account) -> dict | None:
    """What the server knows plus what it has not received, or None when
    the local log has to answer."""
    link = _read()
    if link is None or _account_of(link) != account:
        return None
    try:
        remote = _call(link["url"], link["key"], "GET", "/summary")
    except LinkError as e:
        _note(e.state)
        return None
    _note_answered()
    return play_history.with_unsent(account, remote)


def note_lyrics_offsets(account: Account, offsets: dict[str, float]) -> None:
    with _lock:
        link = _read()
        if link is None or _account_of(link) != account:
            return
        link.setdefault("pending_lyrics_offsets", {}).update(offsets)
        _write(link)
    wake()


def pull_lyrics_offsets(account: Account) -> dict[str, float] | None:
    """The server's corrections with this desktop's unsent ones on top, or
    None when the local copy has to answer."""
    link = _read()
    if link is None or _account_of(link) != account:
        return None
    try:
        remote = _call(
            link["url"], link["key"], "GET", "/lyrics-offsets", timeout=_SETTINGS_TIMEOUT
        )
    except LinkError as e:
        _note(e.state)
        return None
    _note_answered()
    return {**(remote.get("offsets") or {}), **(link.get("pending_lyrics_offsets") or {})}


def relay_now_playing(report: dict | None) -> bool:
    """Passes on what this desktop plays, None for nothing. Whether the
    server has a use for it; not reaching it counts as no, and the next song
    asks again."""
    link = _read()
    if link is None:
        return False
    try:
        answer = _call(
            link["url"],
            link["key"],
            *(("PUT", "/now-playing") if report is not None else ("DELETE", "/now-playing")),
            body=report,
            timeout=_SETTINGS_TIMEOUT,
        )
    except LinkError:
        return False
    return bool(answer.get("wanted"))


def _send_listens(link: dict, account: Account) -> None:
    backfill = bool(link.get("backfill"))
    while True:
        rows = play_history.unsent_listens(account, _BATCH_SIZE)
        if not rows:
            break
        # Only a 2xx gets here: _call raises for everything else.
        _call(link["url"], link["key"], "POST", "/listens", {"listens": rows, "backfill": backfill})
        play_history.mark_sent([row["id"] for row in rows])
        if len(rows) < _BATCH_SIZE:
            break


def _forget_sent(link: dict, field: str, sent: dict) -> None:
    with _lock:
        current = _read()
        if current is None or current["key"] != link["key"]:
            return
        # A value changed again while this was on its way is still unsent.
        current[field] = {k: v for k, v in current[field].items() if k not in sent or sent[k] != v}
        _write(current)


def _send_settings(link: dict) -> None:
    sent = dict(link.get("pending_settings") or {})
    if not sent:
        return
    _call(link["url"], link["key"], "PATCH", "/settings", {"settings": sent})
    _forget_sent(link, "pending_settings", sent)


def _send_lyrics_offsets(link: dict) -> None:
    items = list((link.get("pending_lyrics_offsets") or {}).items())
    for start in range(0, len(items), _OFFSET_BATCH_SIZE):
        sent = dict(items[start : start + _OFFSET_BATCH_SIZE])
        _call(link["url"], link["key"], "PATCH", "/lyrics-offsets", {"offsets": sent})
        _forget_sent(link, "pending_lyrics_offsets", sent)


def _send_milestones(link: dict) -> None:
    sent = link.get("pending_milestones") or {}
    if not sent:
        return
    _call(link["url"], link["key"], "PUT", "/milestones", sent)
    with _lock:
        current = _read()
        if current is None or current["key"] != link["key"]:
            return
        if current.get("pending_milestones") == sent:
            current["pending_milestones"] = {}
            _write(current)


def _adopt_api_keys(link: dict) -> None:
    lent = _call(link["url"], link["key"], "GET", "/api-keys").get("keys") or {}
    for service in api_keys.SERVICES:
        key = lent.get(service)
        api_keys.set_shared(service, key if isinstance(key, str) else "")


def _forget_api_keys() -> None:
    """They were lent for as long as this desktop is paired."""
    for service in api_keys.SERVICES:
        api_keys.set_shared(service, "")


def _mark_synced(link: dict, now: float) -> None:
    with _lock:
        current = _read()
        if current is None or current["key"] != link["key"]:
            return
        current["backfill"] = False
        current["last_sync_at"] = int(now)
        _write(current)


def send_once(now: float | None = None) -> bool:
    """Everything still unsent, in one pass. False if it has to be tried
    again later."""
    link = _read()
    if link is None:
        return True
    try:
        # First, so a pass with nothing to send still finds a server that
        # has gone or a key that was revoked.
        _call(link["url"], link["key"], "GET", "/info")
        _send_listens(link, _account_of(link))
        _send_settings(link)
        _send_lyrics_offsets(link)
        _send_milestones(link)
        _adopt_api_keys(link)
    except LinkError as e:
        _note(e.state)
        if e.state == WRONG_KEY:
            _forget_api_keys()
        logger.info(f"[server-link] Sync paused: {e.state}")
        return False
    _mark_synced(link, time.time() if now is None else now)
    _note(CONNECTED)
    return True


def wake(force: bool = False) -> None:
    """Asks for a pass soon. Ordinary changes wait out a backoff in progress:
    a song ending is no reason to think the server has come back."""
    if _loop is None or _wake_event is None or (_failures and not force):
        return
    _loop.call_soon_threadsafe(_wake_event.set)


def _next_delay() -> float:
    if not _failures:
        return IDLE_SECONDS
    return min(_BACKOFF_BASE_SECONDS * 2 ** (_failures - 1), _BACKOFF_MAX_SECONDS)


async def run() -> None:
    global _loop, _wake_event
    if not AVAILABLE:
        return
    _loop = asyncio.get_running_loop()
    _wake_event = asyncio.Event()
    while True:
        try:
            await asyncio.to_thread(send_once)
        except Exception:
            logger.exception("[server-link] Sync pass failed")
        try:
            await asyncio.wait_for(_wake_event.wait(), timeout=_next_delay())
        except TimeoutError:
            pass
        _wake_event.clear()


def reset_for_tests() -> None:
    global _state, _failures, _loop, _wake_event
    _state = CONNECTED
    _failures = 0
    _loop = None
    _wake_event = None
