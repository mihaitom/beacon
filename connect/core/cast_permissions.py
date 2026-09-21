"""core/cast_permissions.py — who may cast to LAN devices on this
deployment.

An admin of a media server can restrict casting to a list of accounts
("household"); everyone else on the same connect instance may still browse,
play locally and use every other feature, they just cannot grab a speaker.
See docs/cast-permissions.md for the full plan and, importantly, for what
this is *not*: it is a policy among the people sharing a deployment, not a
security boundary. The shared CONNECT_TOKEN is instance-wide, and the
session id is client-asserted and not a secret, so someone who holds the
token can still act as any session. This file decides what an honest client
is allowed to do, nothing stronger.

Rules are server-wide and keyed by `server_type|normalized_server_url`.
Each configured server has a `mode` (allowlist: the listed accounts may
cast; blocklist: the listed accounts may not), a `default_allow` for
accounts not on the list (which is also what a brand-new account gets), and
the list itself. An **absent** entry means the server has never been
configured and everyone may cast — that is the update migration (an
existing instance has no file). An *empty* list is a real configuration:
blocklist with an empty list blocks nobody, allowlist with an empty list
blocks everyone but admins.

Stored as one JSON file under CONNECT_DATA_DIR, written only server-side
(see routes/cast_permissions.py). It deliberately does not live in
account_settings.json: that route takes the account identity as query
parameters and is gated only by the shared token, so anyone could grant
themselves permission there.
"""

import asyncio
import json
import logging
import os
import re
import threading

logger = logging.getLogger("connect.cast_permissions")

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_PATH = os.path.join(_DATA_DIR, "cast_permissions.json")

# Same read-modify-write shape as core/account_settings.py, and the same
# reason: one file holds every server's rules, and two admins (or two
# requests from one admin's open settings page) can write at once. Routes
# are sync `def`, so this is contended by threadpool workers, not
# coroutines — a plain threading.Lock is the right primitive.
_lock = threading.Lock()

# Mirrors the renderer's normalizeServerUrl (services/connect/session-id.ts):
# the rule for a server must be the same whether it was typed with a scheme,
# a trailing slash, an upper-case host or an explicit default port. The
# frontend adopts /config's resolved_url after a redirect, but a second
# session logging in over the other scheme would otherwise miss the rules.
_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
_DEFAULT_PORT_RE = re.compile(r":(?:80|443)$")


def normalize_server_url(url: str) -> str:
    """The server part of a rule key: scheme, trailing slash, host case and
    a default port all removed, so two ways of writing the same login land
    on the same rules."""
    rest = _SCHEME_RE.sub("", url.strip())
    rest = rest.rstrip("/")
    slash = rest.find("/")
    authority = (rest if slash == -1 else rest[:slash]).lower()
    path = "" if slash == -1 else rest[slash:]
    return _DEFAULT_PORT_RE.sub("", authority) + path


def _server_key(server_type: str, server_url: str) -> str:
    return f"{server_type}|{normalize_server_url(server_url)}"


#: The listed accounts may cast; everyone else gets `default_allow`.
_DEFAULT_MODE = "allowlist"
#: The listed accounts may not cast; everyone else gets `default_allow`.
_VALID_MODES = ("allowlist", "blocklist")


def _read_file() -> dict | None:
    """Parsed contents, `{}` when there's no file yet, or `None` when the
    file exists but can't be read back — three answers on purpose, since
    set_accounts() must treat the last one very differently from the second
    (see its own comment)."""
    try:
        with open(_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        logger.warning(f"[cast-permissions] Load failed: {e}")
        return None
    if not isinstance(data, dict):
        logger.warning("[cast-permissions] Load failed: not a JSON object")
        return None
    return data


def _load_servers() -> dict:
    data = _read_file()
    if data is None:
        return {}
    servers = data.get("servers")
    return servers if isinstance(servers, dict) else {}


def _load_known() -> dict:
    data = _read_file()
    if data is None:
        return {}
    known = data.get("known")
    return known if isinstance(known, dict) else {}


def _save_document(document: dict) -> None:
    """Write-to-temp + os.replace(), never a truncate-in-place: this file
    holds every server's rules, so a write interrupted halfway would
    otherwise leave a truncated file that reads back as unparseable."""
    tmp = f"{_PATH}.tmp"
    try:
        os.makedirs(os.path.dirname(_PATH), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(document, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, _PATH)
    except Exception as e:
        logger.error(f"[cast-permissions] Save failed: {e}")
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _move_unreadable_aside() -> None:
    logger.error(f"[cast-permissions] Unreadable store, moving aside to {_PATH}.corrupt")
    try:
        os.replace(_PATH, f"{_PATH}.corrupt")
    except OSError as e:
        logger.error(f"[cast-permissions] Could not move it aside: {e}")


def allowed_accounts(server_type: str, server_url: str) -> list[str]:
    """The usernames on this server's list, in configured order. What the
    list *means* depends on the mode (see policy()): allowed in allowlist
    mode, blocked in blocklist mode. An absent server entry means the list
    is not configured at all, which is not the same as an empty list."""
    key = _server_key(server_type, server_url)
    with _lock:
        entry = _load_servers().get(key)
    if not isinstance(entry, dict):
        return []
    accounts = entry.get("accounts")
    if not isinstance(accounts, list):
        return []
    return [a for a in accounts if isinstance(a, str) and a]


def policy(server_type: str, server_url: str) -> tuple[str, bool] | None:
    """(mode, default_allow) for this server, or None when it has never
    been configured — in which case everyone may cast.

    `mode` is "allowlist" (the listed accounts may cast) or "blocklist"
    (the listed accounts may not). `default_allow` is what accounts *not*
    on the list get, which is also what a brand-new account gets: a new
    account is simply one that is not on the list yet."""
    entry = _server_entry(server_type, server_url)
    if entry is None:
        return None
    mode = entry.get("mode")
    if mode not in _VALID_MODES:
        mode = _DEFAULT_MODE
    return mode, bool(entry.get("default_allow", False))


def _server_entry(server_type: str, server_url: str) -> dict | None:
    key = _server_key(server_type, server_url)
    with _lock:
        entry = _load_servers().get(key)
    return entry if isinstance(entry, dict) else None


def known_accounts(server_type: str, server_url: str) -> list[str]:
    """Every account that has authenticated against this server through
    this Beacon, oldest first. The admin UI's picker offers these, since no
    server type Beacon speaks to can be enumerated uniformly (Navidrome's
    Subsonic getUsers.view answers with the caller alone; Plex has no
    server-side list at all). Persisted, so it survives a restart and
    outlives a session being reaped."""
    key = _server_key(server_type, server_url)
    with _lock:
        names = _load_known().get(key)
    if not isinstance(names, list):
        return []
    return [n for n in names if isinstance(n, str) and n]


def record_account(server_type: str, server_url: str, username: str) -> None:
    """Remember that `username` authenticated against this server. Called
    from /config with the *verified* username only (see
    routes/devices.py) — never with the request body's claim.

    Best-effort: an unreadable store is left untouched rather than moved
    aside, since this is observation, not the admin's configuration, and
    must never be the write that loses the rules."""
    name = username.strip()
    if not name:
        return
    key = _server_key(server_type, server_url)
    with _lock:
        document = _read_file()
        if document is None:
            return
        known = document.get("known")
        known = dict(known) if isinstance(known, dict) else {}
        names = known.get(key)
        names = list(names) if isinstance(names, list) else []
        if any(isinstance(n, str) and n.casefold() == name.casefold() for n in names):
            return
        names.append(name)
        known[key] = names
        document["known"] = known
        _save_document(document)


def set_policy(
    server_type: str,
    server_url: str,
    accounts: list[str],
    mode: str,
    default_allow: bool,
) -> tuple[list[str], str, bool]:
    """Replaces this server's list, mode and unlisted-account default, and
    returns the cleaned values actually stored. Blank entries are dropped
    and duplicates collapsed (case-insensitively).

    The entry is written even for an empty list — unlike the earlier
    allow-only shape, an empty list is now meaningful (blocklist: nothing
    blocked; allowlist: nobody may cast), so "unconfigured" is expressed by
    the entry being absent, not by an empty list."""
    if mode not in _VALID_MODES:
        mode = _DEFAULT_MODE
    cleaned: list[str] = []
    seen: set[str] = set()
    for account in accounts:
        name = account.strip()
        if not name or name.casefold() in seen:
            continue
        seen.add(name.casefold())
        cleaned.append(name)

    key = _server_key(server_type, server_url)
    with _lock:
        document = _read_file()
        if document is None:
            # Existing file, unreadable. Starting from `{}` would hand the
            # next save an empty document and wipe every *other* server's
            # rules (and the known-account list) too, so keep the
            # unreadable copy aside for recovery instead of overwriting it.
            _move_unreadable_aside()
            document = {}
        servers = document.get("servers")
        servers = dict(servers) if isinstance(servers, dict) else {}
        servers[key] = {
            "mode": mode,
            "default_allow": bool(default_allow),
            "accounts": cleaned,
        }
        document["servers"] = servers
        _save_document(document)
    logger.info(
        f"[cast-permissions] Set {mode} with {len(cleaned)} account(s), "
        f"unlisted {'allowed' if default_allow else 'blocked'} for {key}"
    )
    return cleaned, mode, bool(default_allow)


def is_restricted(server_type: str, server_url: str) -> bool:
    """Whether this server has been configured at all (an absent entry
    means everyone may cast)."""
    return _server_entry(server_type, server_url) is not None


def is_allowed(
    server_type: str,
    server_url: str,
    username: str,
    is_admin: bool,
) -> bool:
    """Whether this account may cast on this server.

    Admins always may, listed or not — otherwise an admin could lock
    themselves out of the deployment they manage, with no break-glass path
    left. An unconfigured server allows everyone. Otherwise the listed
    accounts get the mode's answer and everyone else gets `default_allow`;
    an account whose username could not be verified (an empty `username`)
    is treated as not listed, so a transient failure resolving the name
    lands on the configured default rather than silently opening the door.
    """
    if is_admin:
        return True
    current = policy(server_type, server_url)
    if current is None:
        return True
    mode, default_allow = current
    if username:
        wanted = username.casefold()
        if any(a.casefold() == wanted for a in allowed_accounts(server_type, server_url)):
            return mode == "allowlist"
    return default_allow


def authorize(session) -> dict | None:
    """The refusal body for a session that may not cast, or None.

    Reads the verified identity /config resolved onto the session
    (account_server_type/-_url/-_username/-_is_admin). A session that never
    ran /config has empty fields, which maps to "no rules" and is allowed —
    every cast route already requires an authenticated session, so this is
    only about not inventing a refusal for a state that cannot reach here.
    """
    if is_allowed(
        getattr(session, "account_server_type", ""),
        getattr(session, "account_server_url", ""),
        getattr(session, "account_username", ""),
        getattr(session, "account_is_admin", False),
    ):
        return None
    return {
        "error": "cast_forbidden",
        "account": getattr(session, "account_username", "") or session.display_name,
    }


def may_cast(session) -> bool:
    """Read-only counterpart of authorize() for display filtering (/discover,
    the remote's /devices)."""
    return authorize(session) is None


async def authorize_async(session) -> dict | None:
    """authorize() off the event loop: the rules are a JSON file read under
    a threading.Lock, and the cast routes run on the event loop (same
    reasoning as routes/account_settings.py's sync handlers)."""
    return await asyncio.to_thread(authorize, session)
