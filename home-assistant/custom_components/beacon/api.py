"""Beacon's home automation API (docs/home-automation.md in the Beacon repo)."""

import asyncio
import json
import logging
from collections.abc import Callable

import aiohttp
from yarl import URL

_LOGGER = logging.getLogger(__name__)

RETRY_SECONDS = 10


class BeaconError(Exception):
    pass


class BeaconAuthError(BeaconError):
    pass


class BeaconClient:
    def __init__(self, session: aiohttp.ClientSession, host: str, port: int, key: str):
        self._session = session
        self.host = host
        self.port = port
        self._key = key

    @property
    def base(self) -> str:
        return f"http://{self.host}:{self.port}/remote"

    @property
    def _headers(self) -> dict:
        return {"X-Remote-Password": self._key}

    def cover_url(self, cover_art_id: str, session_id: str | None) -> str:
        query = {"id": cover_art_id, "password": self._key}
        if session_id:
            query["session"] = session_id
        return str(URL(f"{self.base}/cover-art").with_query(query))

    async def get_state(self) -> dict:
        try:
            async with self._session.get(
                f"{self.base}/state", headers=self._headers, timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status in (401, 404):
                    raise BeaconAuthError(f"Key rejected ({resp.status})")
                if resp.status != 200:
                    raise BeaconError(f"HTTP {resp.status}")
                return await resp.json()
        except aiohttp.ClientError as e:
            raise BeaconError(str(e)) from e

    async def query(self, path: str, params: dict | None = None) -> dict:
        """One of the library/device lists. The desktop app answers these
        itself, which can take a moment for a first load."""
        try:
            async with self._session.get(
                f"{self.base}/{path}",
                headers=self._headers,
                params=params,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status == 504:
                    # The app loads a list from the media server the first
                    # time it is asked for it, which can outlast Beacon's
                    # relay timeout on a large library. Asking again works.
                    raise BeaconError("Beacon is still loading this list - try again in a moment")
                if resp.status != 200:
                    raise BeaconError(f"{path}: HTTP {resp.status}")
                return await resp.json()
        except aiohttp.ClientError as e:
            raise BeaconError(str(e)) from e

    def favicon_url(self, home_page_url: str | None, hint: str | None) -> str | None:
        if not home_page_url and not hint:
            return None
        query = {"url": home_page_url or "", "min_size": "64", "password": self._key}
        if hint:
            query["hint"] = hint
        return str(URL(f"{self.base}/radio-favicon").with_query(query))

    async def command(self, type_: str, payload: dict | None = None) -> None:
        try:
            async with self._session.post(
                f"{self.base}/command",
                headers=self._headers,
                json={"type": type_, "payload": payload or {}},
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status != 200:
                    raise BeaconError(f"{type_}: HTTP {resp.status} {await resp.text()}")
        except aiohttp.ClientError as e:
            raise BeaconError(str(e)) from e

    async def listen(
        self,
        on_state: Callable[[dict], None],
        on_available: Callable[[bool], None],
    ) -> None:
        """Follows /remote/events until cancelled, reconnecting on its own."""
        while True:
            try:
                async with self._session.get(
                    f"{self.base}/events",
                    headers=self._headers,
                    timeout=aiohttp.ClientTimeout(total=None, sock_read=45),
                ) as resp:
                    if resp.status != 200:
                        raise BeaconError(f"HTTP {resp.status}")
                    on_available(True)
                    async for raw in resp.content:
                        line = raw.decode("utf-8", "replace").strip()
                        if line.startswith("data:"):
                            try:
                                on_state(json.loads(line[5:].strip()))
                            except ValueError:
                                _LOGGER.debug("Unparseable event: %s", line)
            except asyncio.CancelledError:
                raise
            except (BeaconError, aiohttp.ClientError, TimeoutError) as e:
                _LOGGER.debug("Event stream from %s:%s ended: %s", self.host, self.port, e)
            on_available(False)
            await asyncio.sleep(RETRY_SECONDS)
