"""lyrics — Remote lyrics providers for Beacon Connect.

Port of src/main/features/core/lyrics/* (Electron main process) for the web/
Docker build, which has no main process to run those IPC handlers. Only
covers the providers that are plain JSON APIs (no HTML scraping), since the
Connect backend is shipped as a PyInstaller binary and extra native
dependencies (lxml, etc.) would complicate that build across platforms.
Genius is the only provider left out for that reason (Electron-only).

Sub-modules:
  lrclib    lrclib.net (LRC plain/synced lyrics)
  lrcred    lrc.red (plain/synced lyrics, by ISRC or search)
  simpmusic SimpMusic API (plain/synced lyrics) - disabled, see below
  netease   NetEase API (plain/synced lyrics, no translation merge)
  shared    fuzzy search-result ranking
"""

from enum import Enum

from . import lrclib, lrcred, netease, simpmusic
from .shared import artist_matches, has_sung_lines, order_search_results


class LyricSource(str, Enum):
    LRCLIB = "lrclib.net"
    LRCRED = "lrc.red"
    NETEASE = "NetEase"
    SIMPMUSIC = "SimpMusic"


# SimpMusic's API answers every request with 403 "This API is only available
# to SimpMusic clients" (since at least 2026-10-11). Kept in the code in
# case that changes, but nothing asks it while it is listed here.
DISABLED_SOURCES = frozenset({LyricSource.SIMPMUSIC})
ACTIVE_SOURCES = [source for source in LyricSource if source not in DISABLED_SOURCES]


__all__ = [
    "ACTIVE_SOURCES",
    "DISABLED_SOURCES",
    "LyricSource",
    "artist_matches",
    "has_sung_lines",
    "lrclib",
    "lrcred",
    "netease",
    "order_search_results",
    "simpmusic",
]
