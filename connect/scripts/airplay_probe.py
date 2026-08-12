#!/usr/bin/env python3
"""airplay_probe.py — standalone AirPlay scan / pair / stream probe.

Reproduces the delivery.py AirPlay path (scan → set RAOP credentials →
stream_file) WITHOUT the FastAPI app or Feishin UI, so an AirPlay 2 receiver
such as shairport-sync (see docker-compose.airplay-sim.yaml) can be exercised
in isolation with full pyatv debug logging.

  cd connect
  uv run python scripts/airplay_probe.py --name "AirPlay2 Test" --pair
  uv run python scripts/airplay_probe.py --name "AirPlay2 Test" --file tone.wav

Credentials are shared with the app (credentials.py / airplay_credentials.json),
so a device paired here also works in Feishin and vice versa.
"""

import argparse
import asyncio
import logging
import os
import sys

# Allow `from delivery import credentials` regardless of cwd (scripts/ lives under connect/).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from delivery import credentials as creds_store  # noqa: E402

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("probe")


async def _scan(loop, name, protocol, timeout):
    import pyatv

    devices = await pyatv.scan(loop, timeout=timeout, protocol=protocol)
    match = next((d for d in devices if d.name.lower() == name.lower()), None)
    if match is None:
        raise SystemExit(
            f"Device '{name}' not found. Available: {[d.name for d in devices]}"
        )
    return match


async def do_pair(loop, name, timeout):
    import pyatv
    from pyatv.const import Protocol

    conf = await _scan(loop, name, None, timeout)
    logger.info(f"Pairing with '{name}' ({conf.address}) via AirPlay/HAP …")
    pairing = await pyatv.pair(conf, Protocol.AirPlay, loop)
    try:
        await pairing.begin()
        if pairing.device_provides_pin:
            pin = int(input("PIN shown on the device: ").strip())
            pairing.pin(pin)
        else:
            # We choose the PIN; enter the same one on the receiver if it asks.
            pairing.pin(3939)
            logger.info("Using PIN 3939 (enter on receiver if prompted)")
        await pairing.finish()
        creds = pairing.service.credentials
    finally:
        await pairing.close()

    if not creds:
        raise SystemExit("Pairing finished but no credentials were returned.")
    creds_store.save(name, creds)
    logger.info(f"✓ Paired '{name}' — credentials saved")


async def do_stream(loop, name, path, timeout, version):
    import pyatv
    from pyatv.const import Protocol
    from pyatv.settings import AirPlayVersion
    from pyatv.storage.memory_storage import MemoryStorage

    if not os.path.isfile(path):
        raise SystemExit(f"Audio file not found: {path}")

    # A Storage lets us override pyatv's RAOP protocol auto-selection. pyatv
    # otherwise picks the (incubating) AirPlay v2 RAOP path for AirPlay-2
    # devices; forcing v1 uses the proven legacy realtime path instead.
    storage = MemoryStorage()

    # Mirror delivery.py: unpaired → RAOP-only scan; paired → full scan so the
    # AirPlay (HAP) service is exposed, then push creds onto BOTH protocols.
    stored = creds_store.get(name)
    conf = await _scan(loop, name, None if stored else Protocol.RAOP, timeout)

    if stored:
        conf.set_credentials(Protocol.AirPlay, stored)
        has_raop = conf.set_credentials(Protocol.RAOP, stored)
        logger.info(f"Found {conf.address} (paired, raop_creds={has_raop})")
    else:
        logger.info(f"Found {conf.address} (unpaired RAOP)")

    settings = await storage.get_settings(conf)
    settings.protocols.raop.protocol_version = AirPlayVersion(version)
    logger.info(f"Forcing AirPlay RAOP protocol_version = {version}")

    atv = await pyatv.connect(conf, loop, storage=storage)
    try:
        logger.info(f"▶ stream_file({path}) — watch for it to RETURN below …")
        await atv.stream.stream_file(path)
        logger.info("✓ stream_file returned — playback completed cleanly")
    finally:
        close_tasks = atv.close()
        if close_tasks:
            await asyncio.gather(*close_tasks, return_exceptions=True)


def main():
    p = argparse.ArgumentParser(description="AirPlay scan/pair/stream probe")
    p.add_argument("--name", required=True, help="Device name as shown in mDNS")
    p.add_argument("--file", help="Audio file to stream (wav/mp3/flac/…)")
    p.add_argument("--pair", action="store_true", help="Run the pairing flow first")
    p.add_argument("--timeout", type=int, default=10, help="Scan timeout in seconds")
    p.add_argument(
        "--airplay-version",
        choices=["auto", "1", "2"],
        default="auto",
        help="Force pyatv's RAOP protocol version (default: auto). "
        "Use 1 to bypass the fragile AirPlay-2 RAOP path.",
    )
    args = p.parse_args()

    if not args.pair and not args.file:
        p.error("nothing to do — pass --pair and/or --file")

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        if args.pair:
            loop.run_until_complete(do_pair(loop, args.name, args.timeout))
        if args.file:
            loop.run_until_complete(
                do_stream(
                    loop, args.name, args.file, args.timeout, args.airplay_version
                )
            )
    finally:
        loop.close()


if __name__ == "__main__":
    main()
