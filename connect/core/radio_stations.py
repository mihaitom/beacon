"""core/radio_stations.py — self-hosted internet radio stations.

Navidrome/Subsonic already has its own internet radio station management
(getInternetRadioStations.view et al — proxied straight through for a
Subsonic session, see routes/proxy.py); Jellyfin has no equivalent concept
at all. Rather than leave radio unavailable for Jellyfin users when the
frontend already has everything needed to manage stations (see
RadioView.vue), connect hosts its own small station list itself — used only
by media/jellyfin_bridge.py's bridged getInternetRadioStations.view et al,
never consulted for a Subsonic session.

Persisted the same way as AirPlay pairing credentials (see
delivery/credentials.py) — CONNECT_DATA_DIR survives Electron app updates
(the packaged binary's own folder gets replaced wholesale) and Docker
container recreation (mounted volume).
"""

import json
import logging
import os
import uuid

logger = logging.getLogger("connect.radio_stations")

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_PATH = os.path.join(_DATA_DIR, "radio_stations.json")


def _load() -> list[dict]:
    try:
        with open(_PATH, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return []
    except Exception as e:
        logger.warning(f"[radio-stations] Load failed: {e}")
        return []


def _save(stations: list[dict]) -> None:
    try:
        os.makedirs(os.path.dirname(_PATH), exist_ok=True)
        with open(_PATH, "w", encoding="utf-8") as f:
            json.dump(stations, f, indent=2)
    except Exception as e:
        logger.error(f"[radio-stations] Save failed: {e}")


def list_stations() -> list[dict]:
    return _load()


def create(name: str, stream_url: str, home_page_url: str = "") -> dict:
    stations = _load()
    station = {
        "id": str(uuid.uuid4()),
        "name": name,
        "streamUrl": stream_url,
        "homePageUrl": home_page_url,
    }
    stations.append(station)
    _save(stations)
    logger.info(f"[radio-stations] Created: {name}")
    return station


def update(station_id: str, name: str, stream_url: str, home_page_url: str = "") -> bool:
    stations = _load()
    for station in stations:
        if station["id"] == station_id:
            station["name"] = name
            station["streamUrl"] = stream_url
            station["homePageUrl"] = home_page_url
            _save(stations)
            logger.info(f"[radio-stations] Updated: {station_id}")
            return True
    return False


def delete(station_id: str) -> bool:
    stations = _load()
    remaining = [s for s in stations if s["id"] != station_id]
    if len(remaining) == len(stations):
        return False
    _save(remaining)
    logger.info(f"[radio-stations] Deleted: {station_id}")
    return True
