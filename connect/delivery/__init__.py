"""delivery — Audio delivery layer for Beacon Connect.

Sub-modules:
  base        BaseDelivery abstract class
  sonos       SonosDelivery (SoCo / UPnP)
  airplay     AirPlayDelivery (pyatv)
  chromecast  ChromecastDelivery (pychromecast)
  dlna        DlnaDelivery (async-upnp-client, generic UPnP MediaRenderer)
  manager     DeliveryManager + discover_* helpers
  credentials AirPlay pairing credential storage
"""

from . import credentials
from .airplay import AirPlayDelivery
from .base import BaseDelivery
from .chromecast import ChromecastDelivery
from .dlna import DlnaDelivery
from .manager import (
    DeliveryManager,
    discover_airplay,
    discover_chromecast,
    discover_dlna,
    discover_sonos,
)
from .sonos import SonosDelivery

__all__ = [
    "AirPlayDelivery",
    "BaseDelivery",
    "ChromecastDelivery",
    "credentials",
    "DeliveryManager",
    "discover_airplay",
    "discover_chromecast",
    "discover_dlna",
    "discover_sonos",
    "DlnaDelivery",
    "SonosDelivery",
]
