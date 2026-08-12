"""lyrics — Remote lyrics providers for Feishin Connect.

Port of src/main/features/core/lyrics/* (Electron main process) for the web/
Docker build, which has no main process to run those IPC handlers. Only
covers the providers that are plain JSON APIs (no HTML scraping), since the
Connect backend is shipped as a PyInstaller binary and extra native
dependencies (lxml, etc.) would complicate that build across platforms.
Genius is the only provider left out for that reason (Electron-only).

Sub-modules:
  lrclib    lrclib.net (LRC plain/synced lyrics)
  simpmusic SimpMusic API (plain/synced lyrics)
  netease   NetEase API (plain/synced lyrics, no translation merge)
  shared    fuzzy search-result ranking
"""

from enum import Enum

from . import lrclib, netease, simpmusic
from .shared import order_search_results


class LyricSource(str, Enum):
    LRCLIB = "lrclib.net"
    NETEASE = "NetEase"
    SIMPMUSIC = "SimpMusic"


__all__ = [
    "LyricSource",
    "lrclib",
    "netease",
    "order_search_results",
    "simpmusic",
]
