"""scripts/hue_probe.py - can connect drive Hue lights in time with music?

Before anything goes into the app: whether a Hue Entertainment stream
(UDP, DTLS with a pre-shared key) works from Python with what connect
already ships, and how far the lights lag behind the moment a colour is
sent.

    uv run python scripts/hue_probe.py pair
    uv run python scripts/hue_probe.py areas
    uv run python scripts/hue_probe.py pulse AREA_ID --bpm 120 --click

pair    registers with the bridge (press its button first) and stores the
        key in ~/.config/beacon/hue-probe.json - outside the repo.
areas   lists the entertainment areas set up in the Hue app.
pulse   streams a beat to one area: a flash per beat, a different colour
        on the downbeat. --click plays a click track on this computer at
        the same moment; --offset-ms shifts the lights against it until
        both land together, which is the lag to compensate for.

The bridge is found over mDNS unless --bridge is given. Touches nothing
but the chosen area, and only while pulse runs.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import httpx
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lights.hue import DtlsStream, stream_message

CREDS_PATH = Path.home() / ".config" / "beacon" / "hue-probe.json"
# The bridge forwards about 25 updates a second to the lights; sending at
# twice that keeps a lost datagram from showing as a stutter.
SEND_HZ = 50
FLASH_DECAY_SECONDS = 0.12


# ── Bridge over HTTPS ──────────────────────────────────────────────────────


def find_bridge() -> str:
    from zeroconf import ServiceBrowser, Zeroconf

    found: list[str] = []

    class Listener:
        def add_service(self, zc, type_, name):
            info = zc.get_service_info(type_, name)
            if info:
                found.extend(a for a in info.parsed_addresses() if "." in a)

        def update_service(self, *_):
            pass

        def remove_service(self, *_):
            pass

    zc = Zeroconf()
    ServiceBrowser(zc, "_hue._tcp.local.", Listener())
    deadline = time.monotonic() + 5
    while not found and time.monotonic() < deadline:
        time.sleep(0.1)
    zc.close()
    if not found:
        sys.exit("No Hue bridge found over mDNS - pass --bridge IP")
    return found[0]


def client() -> httpx.Client:
    # The bridge's certificate is signed by Signify's own CA; pinning that
    # is the app's job, not the probe's.
    return httpx.Client(verify=False, timeout=5)


def load_creds() -> dict:
    if not CREDS_PATH.exists():
        sys.exit(f"No credentials in {CREDS_PATH} - run `pair` first")
    return json.loads(CREDS_PATH.read_text())


def pair(bridge: str) -> None:
    print(f"Bridge {bridge}: press its link button now (60 s) ...", flush=True)
    body = {"devicetype": "beacon#probe", "generateclientkey": True}
    with client() as http:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            reply = http.post(f"https://{bridge}/api", json=body).json()[0]
            if "success" in reply:
                username = reply["success"]["username"]
                clientkey = reply["success"]["clientkey"]
                # The stream authenticates with the application id, not
                # the username it was issued with.
                auth = http.get(
                    f"https://{bridge}/auth/v1", headers={"hue-application-key": username}
                )
                app_id = auth.headers["hue-application-id"]
                break
            if reply.get("error", {}).get("type") != 101:  # 101: button not pressed
                sys.exit(f"Bridge refused: {reply}")
            time.sleep(1)
        else:
            sys.exit("Timed out waiting for the button")
    CREDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CREDS_PATH.write_text(
        json.dumps(
            {"bridge": bridge, "username": username, "clientkey": clientkey, "app_id": app_id}
        )
    )
    os.chmod(CREDS_PATH, 0o600)
    print(f"Paired. Stored in {CREDS_PATH}")


def entertainment(http: httpx.Client, creds: dict, area_id: str = "") -> dict:
    url = f"https://{creds['bridge']}/clip/v2/resource/entertainment_configuration"
    if area_id:
        url += f"/{area_id}"
    reply = http.get(url, headers={"hue-application-key": creds["username"]})
    reply.raise_for_status()
    return reply.json()


def set_streaming(http: httpx.Client, creds: dict, area_id: str, action: str) -> None:
    url = f"https://{creds['bridge']}/clip/v2/resource/entertainment_configuration/{area_id}"
    reply = http.put(
        url, headers={"hue-application-key": creds["username"]}, json={"action": action}
    )
    reply.raise_for_status()


def areas() -> None:
    creds = load_creds()
    with client() as http:
        data = entertainment(http, creds)["data"]
    if not data:
        print("No entertainment areas - set one up in the Hue app first.")
    for area in data:
        print(
            f"{area['id']}  {area['metadata']['name']!r}  "
            f"{area['configuration_type']}  {area['status']}  "
            f"{len(area['channels'])} channels"
        )
        for ch in area["channels"]:
            p = ch["position"]
            print(
                f"    channel {ch['channel_id']}  x={p['x']:+.2f} y={p['y']:+.2f} z={p['z']:+.2f}"
            )


# ── Pulse ──────────────────────────────────────────────────────────────────


def click_track(bpm: float, seconds: float) -> Path:
    rate = 44100
    out = np.zeros(int(seconds * rate), dtype=np.float32)
    n = int(0.03 * rate)
    t = np.arange(n) / rate
    for beat in range(int(seconds * bpm / 60)):
        freq = 1760.0 if beat % 4 == 0 else 880.0
        start = int(beat * 60 / bpm * rate)
        out[start : start + n] += (np.sin(2 * np.pi * freq * t) * np.exp(-t / 0.008))[
            : len(out) - start
        ]
    path = Path(tempfile.gettempdir()) / "hue-probe-click.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(out, -1, 1) * 30000).astype("<i2").tobytes())
    return path


def pulse(area_id: str, bpm: float, seconds: float, click: bool, offset_ms: float) -> None:
    creds = load_creds()
    with client() as http:
        area = entertainment(http, creds, area_id)["data"][0]
        channel_ids = [ch["channel_id"] for ch in area["channels"]]
        print(f"Area {area['metadata']['name']!r}, channels {channel_ids}")
        set_streaming(http, creds, area_id, "start")
        stream = DtlsStream(creds["bridge"], creds["app_id"], bytes.fromhex(creds["clientkey"]))
        try:
            started = time.monotonic()
            stream.handshake()
            stream._sock.setblocking(True)
            print(f"DTLS up in {(time.monotonic() - started) * 1000:.0f} ms", flush=True)

            player = None
            if click:
                wav = click_track(bpm, seconds + 1)
                player = subprocess.Popen(
                    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", str(wav)]
                )
            start = time.monotonic() + offset_ms / 1000
            period = 60 / bpm
            seq = sent = 0
            next_send = time.monotonic()
            gaps: list[float] = []
            last = None
            while time.monotonic() - start < seconds:
                t = time.monotonic() - start
                if t < 0:
                    level, downbeat = 0.0, False
                else:
                    beat = math.floor(t / period)
                    level = math.exp(-(t - beat * period) / FLASH_DECAY_SECONDS)
                    downbeat = beat % 4 == 0
                rgb = (1.0, 1.0, 1.0) if downbeat else (1.0, 0.45, 0.05)
                colour = tuple(c * level for c in rgb)
                stream.send(stream_message(seq, area_id, dict.fromkeys(channel_ids, colour)))
                now = time.monotonic()
                if last is not None:
                    gaps.append(now - last)
                last = now
                seq += 1
                sent += 1
                next_send += 1 / SEND_HZ
                time.sleep(max(0.0, next_send - time.monotonic()))
            if player:
                player.wait(timeout=5)
        finally:
            stream.close()
            set_streaming(http, creds, area_id, "stop")
    if gaps:
        gaps.sort()
        print(
            f"Sent {sent} frames, {sent / seconds:.1f}/s; gap median "
            f"{gaps[len(gaps) // 2] * 1000:.1f} ms, worst {gaps[-1] * 1000:.1f} ms"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--bridge", help="bridge IP (default: mDNS)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("pair")
    sub.add_parser("areas")
    p = sub.add_parser("pulse")
    p.add_argument("area")
    p.add_argument("--bpm", type=float, default=120)
    p.add_argument("--seconds", type=float, default=20)
    p.add_argument("--click", action="store_true", help="play a click track here too")
    p.add_argument("--offset-ms", type=float, default=0, help="lights later (+) or earlier (-)")
    args = parser.parse_args()

    if args.cmd == "pair":
        pair(args.bridge or find_bridge())
    elif args.cmd == "areas":
        areas()
    else:
        pulse(args.area, args.bpm, args.seconds, args.click, args.offset_ms)


if __name__ == "__main__":
    main()
