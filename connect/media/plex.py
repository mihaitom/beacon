"""media/plex.py — Plex API Client

Plex authenticates an *account* via plex.tv (PIN linking), not a per-server
URL+password like Subsonic/Jellyfin — see routes/plex_auth.py, which uses
the module-level functions below to get from "nothing" to an account token,
then a list of servers that account can reach, each with its own separate
server-scoped accessToken. Only once a server + its token are picked does
PlexClient (below) come into play, the same way JellyfinClient does once
/config has a real token (see media/jellyfin.py).

Field names for the plex.tv responses below are taken from Plex's public
API docs, not yet confirmed against a live account — see PLEX_PLAN.md's
Open Question 2. Adjust the `data[...]` accesses here first if the live
flow doesn't work.
"""

import logging
import secrets
from pathlib import Path
from urllib.parse import quote

import httpx

from . import http_client
from .base import Track

logger = logging.getLogger("connect.plex")

_PLEX_TV = "https://plex.tv"
_CLIENT_ID_FILE = Path(__file__).resolve().parent.parent / ".plex-client-id"
_PRODUCT = "Beacon"


def client_identifier() -> str:
    """Stable id Plex requires on every request (PIN linking, resource
    listing, and later the media server itself) to know which "app" is
    asking — same stability reasoning as media/jellyfin.py's _device_id()
    (a fresh id per request would register a new device/PIN context each
    time instead of one persistent one)."""
    try:
        existing = _CLIENT_ID_FILE.read_text().strip()
        if existing:
            return existing
    except FileNotFoundError:
        pass
    generated = secrets.token_hex(16)
    try:
        _CLIENT_ID_FILE.write_text(generated)
    except OSError:
        pass  # Falls back to a fresh id next restart — not fatal, just loses stability.
    return generated


def _headers(token: str = "") -> dict:
    """Plex defaults to XML for every response — Accept: application/json
    is required on every single call, easy to forget on a new endpoint,
    hence this one shared helper rather than repeating it inline."""
    headers = {
        "Accept": "application/json",
        "X-Plex-Client-Identifier": client_identifier(),
        "X-Plex-Product": _PRODUCT,
    }
    if token:
        headers["X-Plex-Token"] = token
    return headers


def create_pin() -> dict:
    """Starts a Plex PIN-linking login — returns {id, code}. `code` is
    shown to the user embedded in an app.plex.tv/auth link (see
    routes/plex_auth.py, which builds that URL); `id` is polled with
    check_pin() until the user approves it there."""
    response = http_client.post(
        f"{_PLEX_TV}/api/v2/pins",
        params={"strong": "true"},
        headers=_headers(),
        timeout=10,
    )
    response.raise_for_status()
    data = response.json()
    return {"id": data["id"], "code": data["code"]}


def check_pin(pin_id: int) -> str | None:
    """Polls whether the PIN from create_pin() has been approved yet —
    returns the account's authToken once it has, None while still
    pending. Approval happens entirely in the browser tab the frontend
    opened; this just reads the current state."""
    response = http_client.get(
        f"{_PLEX_TV}/api/v2/pins/{pin_id}",
        headers=_headers(),
        timeout=10,
    )
    response.raise_for_status()
    return response.json().get("authToken") or None


def get_account_username(account_token: str) -> str:
    """The Plex account's display name — not in the PIN response itself
    (see check_pin() above, whose authToken is the whole point of that
    call), so this is a separate lookup. Called once, right after PIN
    approval (see routes/plex_auth.py's plex_pin_check()), purely for
    display (SettingsView.vue's account strip, "claimed by" labels
    elsewhere) — login itself doesn't depend on it, so a failure here
    shouldn't fail the login (see the caller's own try/except)."""
    response = http_client.get(
        f"{_PLEX_TV}/api/v2/user",
        headers=_headers(account_token),
        timeout=10,
    )
    response.raise_for_status()
    data = response.json()
    return data.get("username") or data.get("title") or data.get("email") or ""


def _pick_connection(connections: list[dict]) -> dict | None:
    """Prefers a local, plain-HTTP connection — no TLS cert to validate at
    all for a raw LAN IP, sidestepping both the DNS problem and the cert
    problem _connection_url() below is about. Falls back to any local
    connection, then any connection at all (matching Plex's own resource
    ordering)."""
    local = [c for c in connections if c.get("local")]
    for group in (local, connections):
        http = next((c for c in group if c.get("protocol") == "http"), None)
        if http:
            return http
    if local:
        return local[0]
    return connections[0] if connections else None


def _connection_url(connection: dict) -> str:
    """http: builds the URL from address/port directly — a raw IP, no DNS
    lookup needed. https must use the ready-made `uri`'s hostname instead:
    confirmed live (2026-08-17) that a bare IP over HTTPS fails certificate
    validation outright ("certificate is not valid for '<ip>'"), since
    Plex's cert for a local connection is issued for its own
    `*.plex.direct` hostname (a dynamic-DNS domain resolving to the LAN
    IP, so a browser gets a valid cert on a local address), not the raw
    IP — and that hostname itself failed DNS resolution once already (see
    _pick_connection() above, which is why http is preferred whenever it's
    on offer at all)."""
    if connection.get("protocol") == "http":
        address, port = connection.get("address"), connection.get("port")
        if address and port:
            return f"http://{address}:{port}"
    return connection.get("uri", "")


def list_resources(account_token: str) -> list[dict]:
    """Returns every Plex Media Server this account can reach — each with
    its own server-scoped accessToken (distinct from the account token
    passed in), not the account token itself. Picks one reachable
    Connection per server — see _pick_connection()/_connection_url() for
    the local-plain-HTTP-first reasoning; simplified for Phase A beyond
    that (see PLEX_PLAN.md, refine once tested against a real
    remote-relay-only account, which none of this has been yet).

    /api/v2/resources, not the legacy /api/resources — confirmed live
    (2026-08-17): the legacy path answered with an empty 200 body despite
    Accept: application/json (silently falling back to Plex's older
    XML-first behavior for that endpoint specifically), while the PIN
    endpoints above — already on /api/v2/* — worked fine. Consistent v2
    usage avoids the same trap resurfacing on a future endpoint."""
    response = http_client.get(
        f"{_PLEX_TV}/api/v2/resources",
        params={"includeHttps": "1"},
        headers=_headers(account_token),
        timeout=10,
    )
    response.raise_for_status()
    if not response.text.strip():
        logger.warning(
            f"[plex-resources] Empty body from {response.url} "
            f"(status={response.status_code}) — token likely not accepted for this call"
        )
        raise ValueError("Plex returned an empty response for the account's server list")
    servers = []
    for device in response.json():
        if device.get("provides") != "server":
            continue
        connections = device.get("connections") or []
        connection = _pick_connection(connections)
        if not connection:
            continue
        servers.append(
            {
                "name": device.get("name", "Plex Server"),
                "machine_identifier": device.get("clientIdentifier", ""),
                "url": _connection_url(connection),
                "token": device.get("accessToken", ""),
            }
        )
    return servers


class PlexClient:
    def __init__(
        self, url: str, token: str = "", internal_url: str = "", machine_identifier: str = ""
    ):
        self.base_url = url.rstrip("/")
        self.internal_url = (internal_url or url).rstrip("/")
        self.token = token
        # The *server's* clientIdentifier (from list_resources(), plumbed
        # through /config — see routes/devices.py) — distinct from
        # client_identifier() above, which identifies Beacon itself as an
        # app. Needed by media/plex_bridge.py's playlist writes: Plex
        # addresses playlist items via a `server://{machineIdentifier}/...`
        # URI, not a plain id.
        self.machine_identifier = machine_identifier
        # Resolved lazily and cached here by media/plex_bridge.py's
        # _music_section() — every /library/sections/{key}/... browsing
        # call needs it, and a server can mix music in with other,
        # non-music sections (movies, TV, ...). One PlexClient instance
        # lives for a whole session, so this only needs resolving once.
        self.music_section_key: str | None = None

    def auth_headers(self) -> dict:
        """Public accessor for media/plex_bridge.py, mirroring
        JellyfinClient.auth_headers()."""
        return _headers(self.token)

    def _get(self, path: str, **params) -> dict:
        url = f"{self.internal_url}{path}"
        response = http_client.get(url, headers=_headers(self.token), params=params, timeout=10)
        response.raise_for_status()
        return response.json() if response.content else {}

    def get_track(self, track_id: str) -> Track:
        data = self._get(f"/library/metadata/{quote(str(track_id), safe='')}")
        items = data.get("MediaContainer", {}).get("Metadata", [])
        if not items:
            raise RuntimeError(f"Plex track {track_id} not found")
        item = items[0]
        return Track(
            id=str(item["ratingKey"]),
            title=item.get("title", "Unknown"),
            artist=item.get("grandparentTitle", "Unknown"),
            duration=int((item.get("duration") or 0) / 1000),
            # Tracks rarely carry their own art — the album's usually does.
            cover_art_id=str(item.get("parentRatingKey") or item["ratingKey"]),
            album=item.get("parentTitle", ""),
        )

    # /nearest + limit/maxDistance matches python-plexapi's own
    # Audio.sonicallySimilar() (the library every other unofficial Plex
    # client's equivalent feature is built on) — see
    # https://python-plexapi.readthedocs.io/en/latest/modules/audio.html.
    # Confirmed live against a real server (2026-08-20): the endpoint is
    # real (403, not 404), and per Plex's own support article
    # (https://support.plex.tv/articles/sonic-analysis-music/), "Sonic
    # analysis for music is a premium feature and requires an active Plex
    # Pass subscription for the Server admin account" — exactly the 403 a
    # non-Pass test account got back. The server itself having
    # musicAnalysis enabled isn't enough on its own without that
    # subscription. The success-path *response shape* was never actually
    # seen against a Pass-holding account, but there's no real reason to
    # expect it differs from the MediaContainer.Metadata[] list every other
    # Plex track-listing endpoint already confirmed uses (search, album/
    # playlist children — see media/plex_bridge.py's _map_song()) — Plex is
    # consistent about that shape everywhere else, so this reuses
    # get_track()'s own field mapping above rather than inventing a second
    # one. Worth a quick sanity check the first time this actually runs
    # against a Pass account, but not blocked on it.
    #
    # 403 specifically returns [] rather than raising — routes/stream.py's
    # _maybe_autoplay_topup() would otherwise log a real warning on every
    # single top-up attempt for every non-Pass Plex account, forever, for a
    # permanent/expected condition rather than a transient failure worth
    # flagging. Anything else (network error, malformed response, a genuine
    # server problem) still raises, same as get_track()/get_stream_url()
    # above — that caller's own except Exception already logs those.
    def get_similar_songs2(self, seed_id: str, count: int = 10) -> list[Track]:
        try:
            data = self._get(
                f"/library/metadata/{quote(str(seed_id), safe='')}/nearest",
                excludeFields="summary",
                limit=count,
                maxDistance=0.25,
            )
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 403:
                logger.debug(
                    f"[Plex] Sonic Analysis unavailable (no Plex Pass?) for {seed_id}: {e}"
                )
                return []
            raise
        items = data.get("MediaContainer", {}).get("Metadata", [])
        return [
            Track(
                id=str(item["ratingKey"]),
                title=item.get("title", "Unknown"),
                artist=item.get("grandparentTitle", "Unknown"),
                duration=int((item.get("duration") or 0) / 1000),
                cover_art_id=str(item.get("parentRatingKey") or item["ratingKey"]),
                album=item.get("parentTitle", ""),
            )
            for item in items
        ]

    def get_stream_url(self, track_id: str) -> str:
        # Direct play, not the universal transcode endpoint — PLEX_PLAN.md
        # calls for implementing this first and treating transcoding as a
        # stretch goal needing its own live trial-and-error later.
        #
        # Unlike Jellyfin's fixed /Items/{id}/Download pattern, there's no
        # way to construct a Plex track's real streamable path from
        # track_id alone — it's Media[0].Part[0].key, only known after
        # fetching /library/metadata/{id}. That makes this method a real
        # network call, not the pure string builder every caller used to
        # assume (routes/stream.py, routes/waveform.py) — both now wrap
        # their call in asyncio.to_thread() so this blocks a worker thread,
        # not the whole event loop.
        data = self._get(f"/library/metadata/{quote(str(track_id), safe='')}")
        items = data.get("MediaContainer", {}).get("Metadata", [])
        if not items:
            raise RuntimeError(f"Plex track {track_id} not found")
        media_list = items[0].get("Media") or []
        parts = media_list[0].get("Part") if media_list else None
        part_key = parts[0].get("key") if parts else None
        if not part_key:
            raise RuntimeError(f"Plex track {track_id} has no playable Part")
        return f"{self.internal_url}{part_key}?X-Plex-Token={quote(self.token, safe='')}"

    def get_cover_art_url(self, cover_art_id: str, internal: bool = False) -> str | None:
        if not cover_art_id or not self.base_url:
            return None
        base = self.internal_url if internal else self.base_url
        return (
            f"{base}/library/metadata/{quote(str(cover_art_id), safe='')}/thumb"
            f"?X-Plex-Token={quote(self.token, safe='')}"
        )

    def ping(self) -> bool:
        """Verifies the server-scoped token actually authenticates against
        this specific server — /library/sections requires a valid token,
        unlike an anonymous-reachable endpoint."""
        try:
            response = http_client.get(
                f"{self.internal_url}/library/sections",
                headers=_headers(self.token),
                timeout=10,
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"[ping] {self.internal_url}/library/sections failed: {e}")
            return False
