"""core/radio_browser.py — station discovery via the Radio Browser API
(radio-browser.info), for RadioView.vue's "browse stations" dialog.

Radio Browser has no single fixed host: it's a set of independently-run
mirrors, and clients are expected to pick one themselves via DNS rather
than hitting a hardcoded name (https://api.radio-browser.info/'s own
"HowTo" is explicit about this). The documented method is a plain A-record
lookup of `all.api.radio-browser.info`, which returns every mirror's IP;
each IP is then reverse-resolved to get back a real hostname to actually
connect to (needed for TLS to a *name*, not a bare IP, and because that
name is what building a request URL means anyway). Both lookups are
`socket` stdlib calls — no extra dependency for what is, underneath,
exactly what a client library like Home Assistant's `radios` package does
for the same reason.

Servers are shuffled and cached for _SERVER_CACHE_TTL: this list barely
changes, and re-resolving it on every keystroke of a search box would mean
two DNS round trips before the actual search request even goes out. A
search tries each cached server in turn (see search_stations()) so one
mirror being down doesn't fail the whole lookup.

register_click() exists because Radio Browser's own client rules call it a
requirement, not a courtesy: "Send /json/url requests for every click the
user makes, this helps to mark stations as popular." Fired once, when a
browsed station is actually added (routes/radio.py), not on every search
result rendered — that's the moment closest to an actual "listen" this app
can report, and Radio Browser itself dedupes it to once per station per
IP per day regardless.

search_stations() goes through /json/stations/search rather than the
narrower /json/stations/byname/{term} this module started with — the
former takes name and countrycode as independent, combinable filters and,
critically, tolerates both being empty. That last part is what lets the
exact same function serve RadioView.vue's dialog before anyone has typed
anything (name="", ordered by votes/clicks — a starting point to browse
rather than an empty box) and after (name set, whichever country filter is
also active). More than one selected country fans out into one request per
code and merges the results, since Radio Browser's own filter only ever
matches a single code per request — see search_stations()'s own docstring.

list_countries() backs the dialog's country dropdown with Radio Browser's
own /json/countries - the actual values its `countrycode` station filter
accepts, rather than this app guessing at spellings a free-text field
would get wrong. Cached far longer than the server list
(_PICKLIST_CACHE_TTL): which countries exist in the directory at all
changes on the order of never.

Deliberately no equivalent language filter: Radio Browser's own `language`
field is free text a station's *submitter* typed, not a controlled
vocabulary the way `countrycode` is - /json/languages back that up as
mostly noise (typos, multiple languages jammed into one string, casing
that doesn't match what any station actually carries), unlike
/json/countries, which stays clean because stations are geo-tagged by IP
rather than by whatever a submitter chose to type."""

import asyncio
import logging
import random
import socket
import time
from urllib.parse import quote

import httpx

from lyrics.shared import USER_AGENT

logger = logging.getLogger("connect.radio_browser")

_DISCOVERY_HOST = "all.api.radio-browser.info"

# How long a resolved server list is trusted before re-resolving. The set of
# mirrors changes on the order of months, not minutes - this only exists so
# a burst of searches in one sitting pays for the two DNS round trips once.
_SERVER_CACHE_TTL = 3600.0

# The country picklist, on the other hand, is cached for most of a day —
# see this module's own docstring.
_PICKLIST_CACHE_TTL = 6 * 3600.0

# search_stations()'s only two supported values — anything else falls back
# to "votes" rather than being passed through to Radio Browser unchecked.
# Both mean "descending" (reverse=true): a station with more votes/clicks
# is what "top" means for either one, never fewer.
_VALID_ORDERS = {"votes", "clickcount"}

_TIMEOUT = 8.0
_client = httpx.AsyncClient(timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT})

_cached_servers: list[str] = []
_cached_servers_at = 0.0
_cached_countries: list[dict] | None = None
_cached_countries_at = 0.0


async def _discover_servers() -> list[str]:
    """Every reachable mirror's real hostname, shuffled - see this module's
    own docstring for why a DNS lookup is how Radio Browser wants clients
    to find one at all. A stale cached list is handed back on a fresh
    lookup failure rather than an empty one: DNS being flaky right now
    doesn't mean the servers found an hour ago have gone anywhere."""
    global _cached_servers, _cached_servers_at
    now = time.monotonic()
    if _cached_servers and now - _cached_servers_at < _SERVER_CACHE_TTL:
        return _cached_servers

    try:
        _, _, ips = await asyncio.to_thread(socket.gethostbyname_ex, _DISCOVERY_HOST)
    except OSError as e:
        logger.warning(f"[radio-browser] server discovery failed: {e}")
        return _cached_servers

    hostnames = []
    for ip in ips:
        try:
            host, _, _ = await asyncio.to_thread(socket.gethostbyaddr, ip)
        except OSError:
            # A mirror with no PTR record for its own IP - skip it rather
            # than connecting to the bare address, which would fail TLS
            # hostname verification anyway.
            continue
        hostnames.append(host)

    if not hostnames:
        logger.warning("[radio-browser] discovery returned no usable server")
        return _cached_servers

    random.shuffle(hostnames)
    _cached_servers = hostnames
    _cached_servers_at = now
    return _cached_servers


def _to_station(raw: dict) -> dict:
    """Radio Browser's own station shape, trimmed to what RadioView.vue's
    browse dialog needs. `url_resolved` (playlist files decoded, redirects
    followed - what a device would end up actually connecting to) is
    preferred over the raw, station-submitted `url`, falling back to it
    only where a mirror hasn't resolved one yet.

    `country` (not `countrycode`) here is purely for display - see this
    module's own docstring for why that's fine despite the field being
    marked deprecated: Radio Browser generates it straight from
    `countrycode` server-side, so it's already exactly the human-readable
    name search_stations()'s own `countrycode` filter would otherwise need
    a lookup table to produce.

    `votes` is a lifetime, monotonically increasing total; `clickcount`/
    `clicktrend` are rolling 24h figures (a count and its swing from the
    day before) - two different kinds of "popular" is why the table shows
    both rather than picking one. `lastcheckok` is Radio Browser's own
    majority-vote health check across its test servers, not something this
    app verifies itself.

    `languagecodes` (ISO 639-2/B, comma-separated) is shown instead of the
    free-text `language` field for the same reason there is no language
    *filter* (see this module's own docstring): `language` is whatever a
    station's submitter typed, and aggregating it (as /json/languages does)
    surfaces things like "kurdish.", "lumasaba luganda english" alongside
    the genuine entries. `languagecodes` is what a submitter picked from an
    actual list instead - not filterable here for the same reason as
    country (no matching /json/languagecodes picklist to validate a filter
    value against), but a clean couple of letters is worth displaying even
    without one."""
    return {
        "stationuuid": raw.get("stationuuid") or "",
        "name": raw.get("name") or "",
        "url": raw.get("url_resolved") or raw.get("url") or "",
        "homepage": raw.get("homepage") or "",
        "favicon": raw.get("favicon") or "",
        "country": raw.get("country") or "",
        "state": raw.get("state") or "",
        "languagecodes": raw.get("languagecodes") or "",
        "tags": raw.get("tags") or "",
        "codec": raw.get("codec") or "",
        "bitrate": raw.get("bitrate") or None,
        "votes": raw.get("votes") or 0,
        "clickcount": raw.get("clickcount") or 0,
        "clicktrend": raw.get("clicktrend") or 0,
        "lastcheckok": bool(raw.get("lastcheckok")),
    }


async def _search_one(name: str, limit: int, countrycode: str, order: str) -> list[dict] | None:
    """A single Radio Browser query — search_stations() below is just this,
    fanned out once per selected country when there's more than one."""
    servers = await _discover_servers()
    if not servers:
        return None

    params: dict[str, str] = {
        "order": order if order in _VALID_ORDERS else "votes",
        "reverse": "true",
        "limit": str(limit),
        "hidebroken": "true",
    }
    if name:
        params["name"] = name
    if countrycode:
        params["countrycode"] = countrycode

    for host in servers:
        try:
            r = await _client.get(f"https://{host}/json/stations/search", params=params)
            r.raise_for_status()
        except httpx.HTTPError as e:
            logger.info(f"[radio-browser] {host} search failed: {type(e).__name__}: {e}")
            continue

        data = r.json()
        if not isinstance(data, list):
            continue
        return [s for s in (_to_station(raw) for raw in data) if s["url"]]

    logger.warning(f"[radio-browser] every server failed for query={params!r}")
    return None


async def search_stations(
    name: str = "",
    limit: int = 30,
    countrycodes: list[str] | None = None,
    order: str = "votes",
) -> list[dict] | None:
    """Stations matching `name` (optional) and, if given, any of
    `countrycodes` - best-voted or most-played first. None only when every
    mirror was unreachable for every country asked about - distinct from an
    empty list, which means the search itself came back with nothing for
    these filters.

    Radio Browser's own `countrycode` filter matches exactly one code per
    request (see this module's own docstring on why there's no equivalent
    multi-value filter the way `tagList` is for tags), so more than one
    selected country means one request per code, run concurrently and
    merged here - ranked back into a single list by the same `order`
    rather than left as separate blocks, and capped to `limit` overall so
    picking more countries doesn't quietly return more stations than a
    single-country search would. A country whose own request fails doesn't
    sink the others; only every one failing does."""
    codes = countrycodes or [""]
    if len(codes) == 1:
        return await _search_one(name, limit, codes[0], order)

    results = await asyncio.gather(*(_search_one(name, limit, code, order) for code in codes))
    succeeded = [r for r in results if r is not None]
    if not succeeded:
        return None

    seen: set[str] = set()
    merged: list[dict] = []
    for station in (s for group in succeeded for s in group):
        if station["stationuuid"] in seen:
            continue
        seen.add(station["stationuuid"])
        merged.append(station)

    sort_key = "clickcount" if order == "clickcount" else "votes"
    merged.sort(key=lambda s: s[sort_key], reverse=True)
    return merged[:limit]


def _to_picklist_entry(raw: dict) -> dict:
    return {"name": raw.get("name") or "", "code": raw.get("iso_3166_1") or ""}


async def list_countries() -> list[dict] | None:
    """{name, code} for every country Radio Browser has stations for, `code`
    being the ISO 3166-1 value search_stations()'s own `countrycode` filter
    expects. Filtered to entries with at least one station (a `stationcount`
    of 0 would just be a dead-end filter choice) and sorted by name for a
    dropdown a person scans by eye. Cached - a stale answer here on a fresh-
    lookup failure is harmless (see _discover_servers()'s identical
    reasoning): which countries exist doesn't change while a request or two
    fails."""
    global _cached_countries, _cached_countries_at
    now = time.monotonic()
    if _cached_countries is not None and now - _cached_countries_at < _PICKLIST_CACHE_TTL:
        return _cached_countries

    servers = await _discover_servers()
    if not servers:
        return _cached_countries

    for host in servers:
        try:
            r = await _client.get(f"https://{host}/json/countries")
            r.raise_for_status()
        except httpx.HTTPError as e:
            logger.info(f"[radio-browser] {host} /json/countries failed: {type(e).__name__}: {e}")
            continue

        data = r.json()
        if not isinstance(data, list):
            continue
        entries = [
            _to_picklist_entry(raw)
            for raw in data
            if raw.get("name") and raw.get("stationcount", 0) > 0
        ]
        entries.sort(key=lambda e: e["name"].lower())
        _cached_countries = entries
        _cached_countries_at = now
        return entries

    logger.warning("[radio-browser] every server failed for /json/countries")
    return _cached_countries


async def register_click(stationuuid: str) -> None:
    """Best-effort - see this module's own docstring for why this is called
    at all. A failure here is never worth surfacing to whoever just added a
    station; it costs Radio Browser a popularity vote, nothing this app's
    own user would notice or could act on."""
    servers = await _discover_servers()
    if not servers:
        return
    try:
        await _client.get(f"https://{servers[0]}/json/url/{quote(stationuuid, safe='')}")
    except httpx.HTTPError as e:
        logger.info(f"[radio-browser] click registration failed for {stationuuid}: {e}")
