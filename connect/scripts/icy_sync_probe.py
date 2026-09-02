"""scripts/icy_sync_probe.py — does a Sonos report an ICY title when the
surrounding audio becomes *audible*, or already when it reads it off the wire?

That one question decides whether ICY marker injection can measure a cast
device's playback lag well enough to drive the radio visualizer's clock (see
core/visualizer_feed.py's _ASSUMED_DEVICE_LEAD_SECONDS, a guess this would
replace with a measurement). Nothing else about the idea matters until it is
answered, and it cannot be answered by reading documentation.

This probe answers it end to end, touching no production code:

  1. Builds a synthetic "station" — `--period` seconds of a 1kHz tone, then
     the same span of silence, repeated. The transitions are deliberately
     abrupt: the click is a precise, unmistakable audible landmark.
  2. Serves it over HTTP, paced at exactly 1x real time (the same thing
     core/streamer.py's -readrate does for the real relay — without it a
     device slurps the whole buffer and every timing below is meaningless),
     with ICY metadata interleaved. It logs whether the device asked for ICY
     at all, which is the other open question (experiment 1 in the plan).
  3. Injects a numbered marker title at every tone/silence transition and
     records the wall-clock moment it went out.
  4. Subscribes to the speaker's AVTransport eventing and records when that
     marker comes back as <r:streamContent>.

The readout is the delta between those two moments, printed per marker:

  ~0.1-0.5s  the speaker reports on read. It is telling us about the network,
             not about playback — the whole approach is dead.
  ~2-6s      the speaker reports on playback. Cross-check by ear: when the
             terminal prints "TONE ON", the tone should start at that instant.
             If it does, the delta *is* the device lag and the approach works.

The by-ear cross-check is not optional. A plausible-looking delta that does
not line up with what you hear means the number is measuring something else.

    ./.venv/bin/python scripts/icy_sync_probe.py --speaker Arbeitszimmer

Ctrl-C prints a summary. --dry-run skips discovery and casting entirely (it
only builds the audio and serves it), which is enough to check the script
runs without making any noise in the house.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import math
import re
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from html import unescape

import numpy as np

BITRATE_KBPS = 192
SAMPLE_RATE = 44100
TONE_HZ = 1000.0

# <r:streamContent> is where Sonos puts the ICY StreamTitle it is currently
# showing. It arrives twice-escaped: the LastChange document sits escaped
# inside the NOTIFY body, and CurrentTrackMetaData's DIDL sits escaped inside
# that — the same double unescape core/upnp_events.py already does.
_STREAM_CONTENT_RE = re.compile(r"<r:streamContent>(.*?)</r:streamContent>", re.DOTALL)
_PROPERTY_NAME_RE = re.compile(r'<(\w+)\s+val="')
# Sonos has its own field for the ICY title; a generic DLNA renderer that
# parses ICY at all puts it in the standard <dc:title> of CurrentTrackMetaData
# instead. Both are searched — dc:title also carries the *dispatch* title, but
# that one matches no injected marker and is discarded by mark_reported().
_DC_TITLE_RE = re.compile(r"<dc:title>(.*?)</dc:title>", re.DOTALL)

_DIDL_TEMPLATE = (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" '
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
    '<item id="1" parentID="0" restricted="1">'
    "<dc:title>ICY sync probe</dc:title>"
    # audioBroadcast, matching delivery/sonos.py exactly — this is what tells
    # a Sonos "live stream, no seeking", and it is entirely plausible that its
    # metadata handling differs by class. A probe that dispatched differently
    # from production would be measuring a different code path.
    "<upnp:class>object.item.audioItem.{klass}</upnp:class>"
    '<res protocolInfo="http-get:*:audio/mpeg:*">{url}</res>'
    "</item>"
    "</DIDL-Lite>"
)


# ── audio ────────────────────────────────────────────────────────────────


def build_mp3(period: float, total: float) -> tuple[bytes, float]:
    """(encoded MP3, bytes per second). Alternating tone and silence, CBR so
    that a byte offset maps to a content time exactly — VBR would encode the
    tone and the silence at wildly different rates and quietly break that."""
    samples = int(total * SAMPLE_RATE)
    t = np.arange(samples, dtype=np.float64) / SAMPLE_RATE
    tone = (0.45 * np.sin(2 * math.pi * TONE_HZ * t) * 32767).astype(np.int16)
    tone_on = ((t // period).astype(np.int64) % 2) == 0
    pcm = np.where(tone_on, tone, np.int16(0)).astype(np.int16)

    proc = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "1",
            "-i",
            "pipe:0",
            "-ac",
            "2",
            "-acodec",
            "libmp3lame",
            "-b:a",
            f"{BITRATE_KBPS}k",
            # No Xing/LAME header frame — it would sit in front of the audio
            # and shift every byte offset below by one frame.
            "-write_xing",
            "0",
            "-f",
            "mp3",
            "pipe:1",
        ],
        input=pcm.tobytes(),
        stdout=subprocess.PIPE,
        check=True,
    )
    mp3 = proc.stdout
    return mp3, len(mp3) / total


# ── ICY framing ──────────────────────────────────────────────────────────


def icy_block(title: str | None) -> bytes:
    """One ICY metadata block: a length byte counting 16-byte units, then the
    padded payload. A bare 0 means "nothing changed", which is what almost
    every block is."""
    if title is None:
        return b"\x00"
    payload = f"StreamTitle='{title}';".encode("utf-8", errors="replace")
    units = math.ceil(len(payload) / 16)
    return bytes([units]) + payload.ljust(units * 16, b"\x00")


# ── invisible marker candidates ──────────────────────────────────────────

# In production the injected title is what stands on the speaker's display,
# so a marker cannot look like a marker. It does not need to be unique
# though — only *distinguishable from the previous one*, so alternating two
# titles is enough, and a single invisible character carries that bit.
#
# Two things have to hold for a candidate, and they pull against each other:
# the device must report it back intact (or we cannot tell the two apart),
# and it must fire an event at all when only that character changes (a device
# that trims or normalises sees no change and stays silent).
#
# The en-dash entry is the deliberate fallback: visible, but visually near
# enough to a hyphen to pass unnoticed in a song title.
_VARIATIONS: list[tuple[str, str]] = [
    ("zero-width space U+200B", "\u200b"),
    ("trailing space", " "),
    ("no-break space U+00A0", "\u00a0"),
    ("word joiner U+2060", "\u2060"),
    ("en-dash swap (visible fallback)", ""),  # handled specially, see next_title()
]
_VARIATION_FLIPS = 6  # alternations per candidate


# ── probe state ──────────────────────────────────────────────────────────


class Probe:
    def __init__(self, mp3: bytes, rate: float, period: float, metaint: int) -> None:
        self.mp3 = mp3
        self.rate = rate
        self.period = period
        self.metaint = metaint
        self.sent_at: dict[str, tuple[float, bool]] = {}  # title -> (t_inject, tone_on)
        self.deltas: list[float] = []
        # Per connection, not just the first: a Sonos opens more than one
        # (seen live: two for a single dispatch), and recording only the
        # first can report "never asked for ICY" when a later one did.
        self.icy_by_connection: list[bool] = []
        # Reset per dispatch variant by main()'s cycle — "did *this* variant
        # get a device that asks for ICY?"
        self.icy_this_window = False
        self.connections = 0
        # Global, so a title stays unique across reconnects and can still be
        # matched back to its injection time.
        self.marker_seq = 0
        self.notifies = 0
        # Variation mode (experiment 3): None for the normal lag measurement.
        # Content seconds handed to the socket on the live connection. The
        # Chromecast path measures against this instead of against markers:
        # lag = what we have sent − what the device says it has played.
        self.content_sent = 0.0
        self.position_samples: list[tuple[float, float, float]] = []
        self.variations: list[tuple[str, str]] | None = None
        self.var_index = 0
        self.var_flip = 0
        self.var_log: dict[str, dict] = {}

    def next_title(self) -> str | None:
        """The title for the marker now due. None once every variation
        candidate has had its turn."""
        if self.variations is None:
            self.marker_seq += 1
            return f"MARK {self.marker_seq:03d}"

        if self.var_index >= len(self.variations):
            return None
        name, suffix = self.variations[self.var_index]
        # `key` is what a report is matched back on, so it must not contain
        # the part that varies — the en-dash candidate changes a character
        # *inside* the title rather than appending one, and a prefix long
        # enough to include it would never match its own variant.
        key = f"Probe {chr(65 + self.var_index)}"
        base = f"{key} - Track"
        # The visible fallback varies the dash itself rather than appending
        # anything, so there is nothing a device could trim away.
        if suffix == "":
            title = base if self.var_flip % 2 == 0 else base.replace(" - ", " \u2013 ")
        else:
            title = base + (suffix if self.var_flip % 2 else "")

        entry = self.var_log.setdefault(
            name, {"key": key, "sent": 0, "reported": 0, "variants_seen": set()}
        )
        entry["sent"] += 1
        self.var_flip += 1
        if self.var_flip >= _VARIATION_FLIPS:
            self.var_flip = 0
            self.var_index += 1
            print("\n[variation] --- next candidate ---", flush=True)
        return title

    def _log_variation_report(self, title: str) -> bool:
        for name, entry in self.var_log.items():
            if title.startswith(entry["key"]):
                entry["reported"] += 1
                entry["variants_seen"].add(title)
                print(f"  ← variation report [{name}]: {title!r}", flush=True)
                return True
        return False

    def mark_sent(self, title: str, tone_on: bool) -> None:
        self.sent_at[title] = (time.monotonic(), tone_on)
        if self.variations is not None:
            # No tone state here. In variation mode nothing pairs a report
            # back to its injection, so this line is the only one carrying a
            # label — and it prints a device-lag *before* that audio is
            # audible. Reading it as "what the speaker is doing now" is then
            # wrong by more than a whole marker interval, which reads as the
            # pattern being inverted. The label is only meaningful on the
            # REPORT line of the measurement mode, which prints at the
            # audible moment by construction.
            print(f"  → sent    {title!r}", flush=True)
            return
        state = "TONE ON" if tone_on else "SILENCE"
        print(f"  → sent    {title}  ({state})", flush=True)

    def mark_reported(self, title: str) -> None:
        if self.variations is not None:
            self._log_variation_report(title)
            return
        entry = self.sent_at.get(title)
        if entry is None:
            print(f"  ← report  {title}  (no matching injection — ignored)", flush=True)
            return
        t_inject, tone_on = entry
        delta = time.monotonic() - t_inject
        self.deltas.append(delta)
        state = "TONE ON" if tone_on else "SILENCE"
        print(
            f"  ← REPORT  {title}  delta={delta:6.3f}s   "
            f">>> the speaker should be switching to {state} right now <<<",
            flush=True,
        )

    def summary(self) -> str:
        lines = ["", "=" * 68, "SUMMARY", "=" * 68]
        if not self.icy_by_connection and self.variations is None:
            return "\nNo stream request arrived — the speaker never connected."
        asked = sum(self.icy_by_connection)
        lines.append(
            f"  connections that asked for ICY       : "
            f"{asked}/{len(self.icy_by_connection)}"
            f"{'' if asked else '  <- no variant got the device to ask'}"
        )
        lines.append(f"  stream connections                   : {self.connections}")
        # UPnP eventing and markers are meaningless in reported-position mode
        # — Chromecast has neither, and printing "eventing is not working"
        # for a protocol that never uses it reads as a failure that isn't one.
        if not self.position_samples:
            lines.append(
                f"  UPnP NOTIFYs received                : {self.notifies}"
                f"{'  <- eventing itself is not working' if not self.notifies else ''}"
            )
            lines.append(f"  markers injected                     : {len(self.sent_at)}")
            lines.append(f"  markers reported back                : {len(self.deltas)}")

        if self.position_samples:
            lags = sorted(sent - pos for _, sent, pos in self.position_samples)
            steps = {round(pos, 3) for _, _, pos in self.position_samples}
            moved = "" if len(steps) > 1 else "  <- position never moved, unusable"
            budget = "   <- inside the 0.1s budget" if lags[-1] - lags[0] < 0.1 else ""
            lines += [
                "",
                "  REPORTED-POSITION MODE (no ICY)",
                "  " + "-" * 64,
                f"  samples            : {len(self.position_samples)}",
                f"  distinct positions : {len(steps)}{moved}",
                f"  min lag            : {lags[0]:7.3f}s",
                f"  median lag         : {lags[len(lags) // 2]:7.3f}s",
                f"  max lag            : {lags[-1]:7.3f}s",
                f"  spread             : {lags[-1] - lags[0]:7.3f}s{budget}",
                "",
                "  A spread well under 0.1s means the device's own reported",
                "  position is precise enough to drive the visualizer clock",
                "  directly — no ICY marker round-trip needed for this protocol.",
                "  A single distinct position means it never advances, which is",
                "  what a Sonos does for a stream and why ICY exists here.",
            ]
            return "\n".join(lines)

        if self.variations is not None:
            lines += ["", "  VARIATION CANDIDATES", "  " + "-" * 64]
            for name, entry in self.var_log.items():
                distinct = len(entry["variants_seen"])
                # Two distinct strings coming back means the device both
                # noticed the change and preserved it — the only outcome
                # that makes a candidate usable.
                usable = distinct >= 2 and entry["reported"] >= 2
                why = (
                    "USABLE"
                    if usable
                    else (
                        "device never reported it"
                        if entry["reported"] == 0
                        else "only one distinct string came back — trimmed or deduped"
                    )
                )
                lines.append(
                    f"  {name:34s} sent={entry['sent']:2d} "
                    f"reported={entry['reported']:2d} distinct={distinct} -> {why}"
                )
                for v in sorted(entry["variants_seen"]):
                    lines.append(f"      {v!r}")
            return "\n".join(lines)

        if self.deltas:
            ordered = sorted(self.deltas)
            median = ordered[len(ordered) // 2]
            lines += [
                "",
                f"  min delta    : {ordered[0]:6.3f}s   <- the estimator would use this",
                f"  median delta : {median:6.3f}s",
                f"  max delta    : {ordered[-1]:6.3f}s",
                f"  spread       : {ordered[-1] - ordered[0]:6.3f}s",
                "",
                "  Reading it:",
                "    min < 1s   -> reports on read. Dead end, the number is network latency.",
                "    min 2-6s   -> reports on playback, IF the tone switched when the",
                "                  terminal said so. That min is the device lag.",
                "    spread     -> event moderation. The plan's min-estimator eats it.",
            ]
        else:
            lines.append("\n  Nothing came back. Either eventing never subscribed, or the")
            lines.append("  device does not report ICY titles at all.")
        return "\n".join(lines)


# ── HTTP ─────────────────────────────────────────────────────────────────


async def serve_stream(probe: Probe, writer: asyncio.StreamWriter, headers: dict) -> None:
    wants_icy = headers.get("icy-metadata", "").strip() == "1"
    probe.connections += 1
    probe.icy_by_connection.append(wants_icy)
    probe.icy_this_window = probe.icy_this_window or wants_icy
    print(
        f"\n[stream] connection #{probe.connections} — "
        f"Icy-MetaData: {'1 (good)' if wants_icy else 'absent (!)'}",
        flush=True,
    )
    print(f"[stream] request headers: {headers}\n", flush=True)

    resp = [
        "HTTP/1.1 200 OK",
        "Content-Type: audio/mpeg",
        "Cache-Control: no-cache",
        "icy-name: ICY sync probe",
        # The Cast receiver is a web app and applies CORS to its media, so a
        # server without these is refused before a byte is read — the failure
        # shows up only as player_state=UNKNOWN on our side, with no request
        # ever arriving here. Sonos and DLNA do not care either way.
        "Access-Control-Allow-Origin: *",
        "Access-Control-Allow-Methods: GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers: *",
        "Accept-Ranges: none",
        "Connection: close",
    ]
    if wants_icy:
        resp.append(f"icy-metaint: {probe.metaint}")
    writer.write(("\r\n".join(resp) + "\r\n\r\n").encode())
    await writer.drain()

    start = time.monotonic()
    pos = 0  # byte offset into the encoded MP3
    crossings = 0  # transitions passed on *this* connection
    total = len(probe.mp3)

    while pos < total:
        chunk = probe.mp3[pos : pos + probe.metaint]
        # Pace on content time, computed from the absolute byte position
        # rather than accumulated sleeps — the latter drifts.
        due = start + pos / probe.rate
        now = time.monotonic()
        if due > now:
            await asyncio.sleep(due - now)

        writer.write(chunk)
        pos += len(chunk)
        probe.content_sent = pos / probe.rate

        # Has this block carried us across a transition? content_time is the
        # time of the *end* of what was just written, which is the earliest
        # moment the marker can legitimately describe.
        content_time = pos / probe.rate
        crossed = int(content_time // probe.period)
        title = None
        if crossed > crossings:
            crossings = crossed
            title = probe.next_title()

        writer.write(icy_block(title) if wants_icy else b"")
        await writer.drain()

        if title is not None:
            # Timestamped after drain(), so it reflects the moment the bytes
            # actually reached the kernel rather than when we decided to send.
            probe.mark_sent(title, tone_on=(crossings % 2) == 0)

    print("[stream] test material exhausted", flush=True)


async def handle(probe: Probe, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        request_line = await reader.readline()
        if not request_line:
            return
        parts = request_line.decode("latin-1").split()
        if len(parts) < 2:
            return
        method, path = parts[0], parts[1]

        headers: dict[str, str] = {}
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break
            key, _, value = line.decode("latin-1").partition(":")
            headers[key.strip().lower()] = value.strip()

        if method == "NOTIFY":
            length = int(headers.get("content-length", "0"))
            body = (await reader.readexactly(length)).decode("utf-8", errors="replace")
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            probe.notifies += 1
            text = unescape(unescape(body))
            titles = [
                t.strip() for t in _STREAM_CONTENT_RE.findall(text) + _DC_TITLE_RE.findall(text)
            ]
            # Log every event, not only the ones carrying a marker: "no
            # markers came back" and "no events arrive at all" are entirely
            # different failures, and the summary can't tell them apart
            # without this.
            props = sorted(set(_PROPERTY_NAME_RE.findall(text)))
            print(
                f"  · NOTIFY #{probe.notifies}: {', '.join(props[:8]) or 'no parsable properties'}"
                f"{f'  streamContent={titles!r}' if titles else ''}",
                flush=True,
            )
            for title in titles:
                probe.mark_reported(title)
            return

        if method == "OPTIONS":
            # Preflight. A Cast receiver sends one before it will touch the
            # media at all.
            writer.write(
                b"HTTP/1.1 204 No Content\r\n"
                b"Access-Control-Allow-Origin: *\r\n"
                b"Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
                b"Access-Control-Allow-Headers: *\r\n"
                b"Content-Length: 0\r\n\r\n"
            )
            await writer.drain()
            print(f"[stream] OPTIONS preflight from {headers.get('origin', '?')}", flush=True)
            return

        if path.startswith("/stream"):
            if method == "HEAD":
                print("[stream] HEAD probe", flush=True)
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\n"
                    b"Access-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n"
                )
                await writer.drain()
                return
            await serve_stream(probe, writer, headers)
            return

        writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
    except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
        pass
    finally:
        with contextlib.suppress(Exception):
            writer.close()


# ── UPnP ─────────────────────────────────────────────────────────────────


def local_ip_towards(host: str) -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((host, 1400))
        return s.getsockname()[0]
    finally:
        s.close()


def subscribe(event_url: str, callback_url: str) -> str | None:
    import urllib.error
    import urllib.request

    req = urllib.request.Request(event_url, method="SUBSCRIBE")
    req.add_header("CALLBACK", f"<{callback_url}>")
    req.add_header("NT", "upnp:event")
    req.add_header("TIMEOUT", "Second-1800")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.headers.get("SID")
    except (urllib.error.URLError, OSError) as e:
        print(f"[upnp] SUBSCRIBE failed: {e}", flush=True)
        return None


def discover_sonos() -> list[tuple[str, object]]:
    import soco

    devices = soco.discover(timeout=6) or set()
    return sorted(((d.player_name, d) for d in devices), key=lambda t: t[0])


# ── dispatch variants ────────────────────────────────────────────────────

# Whether a device asks for ICY at all is decided *before* it sees any of our
# response — the header is in its own request — so nothing about how we serve
# the stream can influence it. Only the dispatch can: the URI scheme and what
# the path looks like. Sonos has its own scheme for internet radio
# (x-rincon-mp3radio://), and handing it a plain http:// URI may well be why
# it treats the stream as a file and never asks. Variant 1 is exactly what
# delivery/sonos.py does in production, so it doubles as the control.
_VARIANTS: list[tuple[str, str, str]] = [
    ("http + /stream", "http://{host}/stream", "audioBroadcast"),
    ("http + /stream.mp3", "http://{host}/stream.mp3", "audioBroadcast"),
    ("x-rincon-mp3radio + /stream", "x-rincon-mp3radio://{host}/stream", "audioBroadcast"),
    ("x-rincon-mp3radio + /stream.mp3", "x-rincon-mp3radio://{host}/stream.mp3", "audioBroadcast"),
    (
        "x-rincon-mp3radio://http:// + /stream",
        "x-rincon-mp3radio://http://{host}/stream",
        "audioBroadcast",
    ),
    ("http + /stream, musicTrack class", "http://{host}/stream", "musicTrack"),
]


async def _dispatch(probe, device, uri: str, klass: str, name: str) -> bool:
    probe.icy_this_window = False
    print(f"\n{'━' * 68}\n[variant] {name}\n[variant] URI: {uri}", flush=True)
    # Nothing playing yet on the first pass — and a device that refuses to
    # stop still accepts the SetAVTransportURI below.
    with contextlib.suppress(Exception):
        await asyncio.to_thread(device.stop)
    await asyncio.sleep(0.5)
    try:
        await asyncio.to_thread(
            device.avTransport.SetAVTransportURI,
            [
                ("InstanceID", 0),
                ("CurrentURI", uri),
                ("CurrentURIMetaData", _DIDL_TEMPLATE.format(url=uri, klass=klass)),
            ],
        )
        await asyncio.to_thread(device.avTransport.Play, [("InstanceID", 0), ("Speed", 1)])
    except Exception as e:
        print(f"[variant] REFUSED by the device: {e}", flush=True)
        return False
    return True


async def dispatch_variant(probe, device, ip: str, port: int, name: str) -> str | None:
    """Dispatch one named variant and stay on it, no cycling."""
    for vname, template, klass in _VARIANTS:
        if vname == name:
            ok = await _dispatch(probe, device, template.format(host=f"{ip}:{port}"), klass, vname)
            return vname if ok else None
    sys.exit(f"No variant named {name!r}. --list-variants shows them.")


async def cycle_variants(probe, device, ip: str, port: int, window: float) -> str | None:
    """Dispatch each variant in turn, stopping at the first that gets the
    device to ask for ICY. Returns that variant's name, or None."""
    host = f"{ip}:{port}"
    for name, template, klass in _VARIANTS:
        if not await _dispatch(probe, device, template.format(host=host), klass, name):
            continue
        await asyncio.sleep(window)
        verdict = "ASKED FOR ICY" if probe.icy_this_window else "did not ask"
        print(f"[variant] {name}: {verdict}", flush=True)
        if probe.icy_this_window:
            return name
    return None


# ── DLNA ─────────────────────────────────────────────────────────────────

_AVTRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1"


async def discover_dlna() -> list[tuple[str, object]]:
    """Same SSDP search delivery/manager.py uses, minus the name cache it
    keeps for the app's own /discover."""
    from async_upnp_client.aiohttp import AiohttpRequester
    from async_upnp_client.client_factory import UpnpFactory
    from async_upnp_client.search import async_search

    locations: set[str] = set()

    async def on_response(headers) -> None:
        if loc := headers.get("LOCATION"):
            locations.add(loc)

    await async_search(
        async_callback=on_response,
        timeout=6,
        search_target="urn:schemas-upnp-org:device:MediaRenderer:1",
    )

    factory = UpnpFactory(AiohttpRequester(), non_strict=True)
    found: list[tuple[str, object]] = []
    for loc in sorted(locations):
        try:
            device = await factory.async_create_device(loc)
        except Exception as e:
            print(f"[dlna] {loc} answered SSDP but could not be read: {e}", flush=True)
            continue
        # async_upnp_client raises KeyError for a missing service rather
        # than returning None — a renderer without AVTransport cannot be
        # dispatched to, and several things on a home network answer the
        # MediaRenderer search without having it.
        try:
            device.service(_AVTRANSPORT)
        except KeyError:
            continue
        # Every Sonos also advertises a generic MediaRenderer, and there are
        # far more of those here than real DLNA devices — without this the
        # picker fills up with speakers that already have a better path.
        # delivery/manager.py filters on the same field.
        if "sonos" in (device.manufacturer or "").lower():
            continue
        found.append((device.friendly_name, device))
    return sorted(found, key=lambda t: t[0])


async def dispatch_dlna(probe, device, ip: str, port: int) -> str | None:
    """Plain http:// — x-rincon-mp3radio:// is a Sonos invention and a
    generic renderer would simply refuse the URI."""
    uri = f"http://{ip}:{port}/stream"
    service = device.service(_AVTRANSPORT)
    print(f"\n{'━' * 68}\n[dlna] {device.friendly_name}\n[dlna] URI: {uri}", flush=True)
    with contextlib.suppress(Exception):
        await service.action("Stop").async_call(InstanceID=0)
    try:
        await service.action("SetAVTransportURI").async_call(
            InstanceID=0,
            CurrentURI=uri,
            CurrentURIMetaData=_DIDL_TEMPLATE.format(url=uri, klass="audioBroadcast"),
        )
        await service.action("Play").async_call(InstanceID=0, Speed="1")
    except Exception as e:
        print(f"[dlna] dispatch REFUSED: {e}", flush=True)
        return None
    return "dlna + http + /stream"


def _parse_reltime(value: str | None) -> float | None:
    """GetPositionInfo's RelTime is "H:MM:SS" (no fractional seconds — 1s is
    the ceiling on resolution no matter how this is parsed), or the literal
    string "NOT_IMPLEMENTED" for a renderer that doesn't track it at all."""
    if not value or value == "NOT_IMPLEMENTED":
        return None
    parts = value.split(":")
    if len(parts) != 3:
        return None
    try:
        h, m, s = parts
        return int(h) * 3600 + int(m) * 60 + float(s)
    except ValueError:
        return None


async def run_dlna_position(probe, service, uri: str, seconds: float) -> None:
    """AVTransport's GetPositionInfo, polled the same way run_chromecast()
    polls adjusted_current_time — worth trying now that a large-but-stable
    device-side buffer measured fine there for a device that also has no
    ICY channel worth using. Whether RelTime moves at all for a live stream
    on a given renderer was never tested before (the DLNA section above
    dead-ended on ICY specifically, which is a separate question from
    whether GetPositionInfo works) — see delivery/dlna.py's own
    get_position(), which already reads this same action for track
    playback via async_upnp_client's higher-level wrapper."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        await asyncio.sleep(0.5)
        try:
            result = await service.action("GetPositionInfo").async_call(InstanceID=0)
        except Exception as e:
            print(f"  · GetPositionInfo failed: {e}", flush=True)
            continue

        track_uri = result.get("TrackURI") or ""
        if track_uri and uri not in track_uri:
            print(
                f"\n[dlna] the device switched to another stream ({track_uri[:60]}) — stopping.",
                flush=True,
            )
            return

        pos = _parse_reltime(result.get("RelTime"))
        if pos is None:
            print(f"  · RelTime unavailable ({result.get('RelTime')!r})", flush=True)
            continue

        sent = probe.content_sent
        if sent <= 0:
            continue
        probe.position_samples.append((time.monotonic(), sent, pos))
        print(f"  · sent={sent:7.2f}s  device={pos:7.2f}s  lag={sent - pos:6.3f}s", flush=True)


# ── Chromecast ───────────────────────────────────────────────────────────


_CAST_ZCONF = None


def discover_chromecast() -> list[tuple[str, object]]:
    """CastBrowser rather than get_chromecasts(): the latter found nothing
    here while the app itself listed the same devices fine. delivery/
    chromecast.py keeps a long-lived browser and gives mDNS a few seconds
    before reading it, which is what actually works — a one-shot discovery
    call returns before the responses are in. The zeroconf instance has to
    outlive discovery too; the cast socket client needs it."""
    global _CAST_ZCONF
    import pychromecast
    import zeroconf as zc

    _CAST_ZCONF = zc.Zeroconf()
    browser = pychromecast.discovery.CastBrowser(
        pychromecast.discovery.SimpleCastListener(), _CAST_ZCONF
    )
    browser.start_discovery()
    time.sleep(6)
    return sorted(((i.friendly_name, i) for i in browser.devices.values()), key=lambda t: t[0])


def connect_chromecast(cast_info):
    import pychromecast

    cast = pychromecast.get_chromecast_from_cast_info(cast_info, _CAST_ZCONF)
    cast.wait(timeout=15)
    return cast


async def run_chromecast(probe, cast, ip: str, port: int, seconds: float) -> None:
    """Chromecast has no ICY channel worth using, but it does report a real
    playback position as a float (delivery/chromecast.py already reads it as
    adjusted_current_time). That makes the marker round-trip unnecessary
    here: the lag is simply what we have handed to the socket minus what the
    device says it has played.

    What this measures is whether that position is usable for a *live*
    stream at all — it may sit at 0, jump, or advance in coarse steps, none
    of which the app would notice from a single reading."""
    uri = f"http://{ip}:{port}/stream"
    mc = cast.media_controller
    print(f"\n{'━' * 68}\n[cast] {cast.name}\n[cast] URI: {uri}", flush=True)

    import pychromecast

    with contextlib.suppress(Exception):
        await asyncio.to_thread(mc.update_status)

    # play_media() does NOT launch the default receiver — it sends a LOAD to
    # whichever app currently holds the session. On a Google TV that is the
    # set's own "Media Player", which swallows the LOAD: no request ever
    # reaches this server, while mc.status keeps reporting *that* app's
    # playback. Observed as a position advancing past 600s on a PAUSED
    # session across three separate runs, with zero HTTP requests here.
    # Confirmed root cause 2026-09-02 and fixed the same way in
    # delivery/chromecast.py: start_app() only actually launches when a
    # different app is running (a no-op otherwise), so calling it
    # unconditionally is cheap and removes the need to ever manually coax
    # the TV back to idle before running this probe.
    app_id = cast.app_id
    if app_id != pychromecast.APP_MEDIA_RECEIVER:
        print(
            f"[cast] {cast.name} is running {getattr(cast.status, 'display_name', '?')} "
            f"(id={app_id}) — switching to the default media receiver first.",
            flush=True,
        )
        await asyncio.to_thread(cast.start_app, pychromecast.APP_MEDIA_RECEIVER)
        await asyncio.to_thread(mc.update_status)
    if (existing := mc.status.content_id) and existing != uri:
        sys.exit(
            f"\n[cast] {cast.name} is already playing something else:\n"
            f"       {existing[:100]}\n"
            f"       state={mc.status.player_state}\n\n"
            "Stop that first and run again — taking the session over from here\n"
            "would measure the wrong stream."
        )

    await asyncio.to_thread(mc.play_media, uri, "audio/mpeg", stream_type="LIVE")
    await asyncio.to_thread(mc.block_until_active, 20)
    app = getattr(cast.status, "display_name", None)
    print(f"[cast] receiver app: {app or 'none launched'}", flush=True)

    deadline = time.monotonic() + seconds
    warned = False
    while time.monotonic() < deadline:
        await asyncio.sleep(0.5)
        # Without this the status only changes when the device volunteers a
        # MEDIA_STATUS. A receiver that refused the media never sends one, so
        # polling it is the difference between "UNKNOWN forever" and seeing
        # the actual idle_reason.
        with contextlib.suppress(Exception):
            await asyncio.to_thread(mc.update_status)
        status = mc.status

        # Re-checked every sample, not just once: something else can claim
        # the device mid-run, and every reading after that would belong to
        # that stream instead of ours.
        if status.content_id and status.content_id != uri:
            print(
                f"\n[cast] the device switched to another stream "
                f"({status.content_id[:60]}) — stopping.",
                flush=True,
            )
            return

        pos = status.adjusted_current_time
        if status.player_state not in ("PLAYING", "BUFFERING") or pos is None:
            print(
                f"  · state={status.player_state} "
                f"idle_reason={status.idle_reason or '—'} position={pos}",
                flush=True,
            )
            if not warned and probe.connections == 0 and time.monotonic() > deadline - seconds + 6:
                warned = True
                print(
                    "\n  Six seconds in and the device has not fetched the stream once.\n"
                    "  It is refusing before the first byte — receiver-side (CORS, the\n"
                    "  content type, the app not launching), not a streaming problem.\n",
                    flush=True,
                )
            continue

        sent = probe.content_sent
        if sent <= 0:
            continue
        probe.position_samples.append((time.monotonic(), sent, pos))
        print(f"  · sent={sent:7.2f}s  device={pos:7.2f}s  lag={sent - pos:6.3f}s", flush=True)


# ── target selection ─────────────────────────────────────────────────────


@dataclass
class Target:
    protocol: str
    name: str
    handle: object


async def find_targets(protocol: str | None) -> list[Target]:
    """Discover one protocol, or all three at once. Run concurrently — each
    scan is six to eight seconds of waiting on the network, and doing them
    in sequence triples that for no reason."""
    wanted = [protocol] if protocol else ["sonos", "dlna", "chromecast"]
    print(f"[scan] looking for {', '.join(wanted)} ...", flush=True)

    jobs = {
        "sonos": asyncio.to_thread(discover_sonos),
        "dlna": discover_dlna(),
        "chromecast": asyncio.to_thread(discover_chromecast),
    }
    results = await asyncio.gather(*(jobs[w] for w in wanted), return_exceptions=True)

    targets: list[Target] = []
    for proto, result in zip(wanted, results, strict=True):
        if isinstance(result, BaseException):
            print(f"[scan] {proto} discovery failed: {result}", flush=True)
            continue
        targets += [Target(proto, name, handle) for name, handle in result]
    return targets


def choose_target(targets: list[Target], name: str | None, protocol: str | None) -> Target:
    if protocol:
        # Not redundant with find_targets(): room names are reused across
        # protocols (a Sonos and a TV both called "Wohnzimmer" here), so
        # without this a --protocol chromecast run could hand back the Sonos
        # of the same name.
        targets = [t for t in targets if t.protocol == protocol]
    if not targets:
        sys.exit("Nothing found. Is this machine on the same network as the devices?")

    if name:
        matches = [t for t in targets if t.name.lower() == name.lower()]
        if not matches:
            sys.exit(
                f"No device named {name!r}. Found:\n"
                + "\n".join(f"  {t.protocol:11s} {t.name}" for t in targets)
            )
        if len(matches) > 1 and protocol is None:
            # A Sonos answers Chromecast discovery on some models, and room
            # names get reused across protocols — ask rather than guess.
            print(f"\n{name!r} exists on more than one protocol:")
            targets = matches
        else:
            return matches[0]

    print("\nFound devices:\n")
    for i, t in enumerate(targets, 1):
        note = {
            "sonos": "ICY marker round-trip — measured, works",
            "dlna": "ICY marker round-trip — untested",
            "chromecast": "reported position, no ICY — untested",
        }[t.protocol]
        print(f"  {i:2d})  {t.protocol:11s} {t.name:38s} {note}")

    if not sys.stdin.isatty():
        sys.exit("\nNot a terminal — pass --speaker (and --protocol) to choose.")

    while True:
        raw = input(f"\nWhich one? [1-{len(targets)}, or q to quit] ").strip()
        if raw.lower() in ("q", "quit", ""):
            sys.exit("Nothing selected.")
        if raw.isdigit() and 1 <= int(raw) <= len(targets):
            return targets[int(raw) - 1]
        print("  not a listed number")


# ── main ─────────────────────────────────────────────────────────────────

# Set by main() so the Ctrl-C handler can still print the summary — the run
# ends by interrupt every time, so a summary only reachable on a clean return
# would never actually be printed.
_PROBE: Probe | None = None


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--protocol",
        choices=("sonos", "dlna", "chromecast"),
        default=None,
        help="restrict the scan to one protocol. Omitted, all three are "
        "scanned at once and you pick from the list. sonos/dlna use the ICY "
        "marker round-trip; chromecast has no usable ICY channel but reports "
        "a real float position, so the lag is read off that directly. AirPlay "
        "is absent on purpose — see the module docstring.",
    )
    ap.add_argument("--speaker", help="device name; omitted, you pick from a list")
    ap.add_argument("--port", type=int, default=7099)
    ap.add_argument("--period", type=float, default=5.0, help="seconds of tone, then silence")
    ap.add_argument("--duration", type=float, default=300.0, help="total test material")
    ap.add_argument(
        "--metaint",
        type=int,
        default=8192,
        help="ICY metadata interval. 8192 is the common value and the safest "
        "first run (341ms injection granularity at 192kbps) — plenty to tell "
        "0.3s from 3s. Lower it for a precision run once the direction is known.",
    )
    ap.add_argument(
        "--window",
        type=float,
        default=14.0,
        help="seconds to give each dispatch variant before moving on. The ICY "
        "request, if it comes, is in the device's very first GET — this only "
        "has to cover connecting, not playing.",
    )
    ap.add_argument(
        "--uri-variant",
        help="skip the cycle and dispatch this variant straight away, by name "
        "(e.g. 'x-rincon-mp3radio + /stream'). --list-variants prints them.",
    )
    ap.add_argument("--list-variants", action="store_true", help="print variant names and exit")
    ap.add_argument(
        "--test-variations",
        action="store_true",
        help="experiment 3: instead of measuring lag, alternate between two "
        "titles differing only by an invisible character and report which "
        "candidates the device both notices and reports back intact. Needs "
        "--uri-variant (or the cycle) to have found a working dispatch first.",
    )
    ap.add_argument("--dry-run", action="store_true", help="serve only; no discovery, no casting")
    args = ap.parse_args()

    if args.list_variants:
        for name, template, klass in _VARIANTS:
            print(f"  {name:38s} {template}  ({klass})")
        return

    if args.test_variations:
        # A fixed, short cadence — the audio pattern is irrelevant here, only
        # how often the title flips.
        args.period = 4.0

    print(
        f"[audio] encoding {args.duration:.0f}s of {args.period:.0f}s tone / "
        f"{args.period:.0f}s silence ...",
        flush=True,
    )
    mp3, rate = build_mp3(args.period, args.duration)
    print(
        f"[audio] {len(mp3)} bytes, {rate:.0f} B/s "
        f"({rate * 8 / 1000:.0f} kbit/s), {args.metaint / rate * 1000:.0f}ms per ICY block\n",
        flush=True,
    )

    global _PROBE
    probe = _PROBE = Probe(mp3, rate, args.period, args.metaint)
    if args.test_variations:
        probe.variations = _VARIATIONS
        print(
            f"[mode] variation test — {len(_VARIATIONS)} candidates, "
            f"{_VARIATION_FLIPS} flips each, {args.period:.0f}s apart\n",
            flush=True,
        )
    server = await asyncio.start_server(lambda r, w: handle(probe, r, w), "0.0.0.0", args.port)

    if args.dry_run:
        ip = local_ip_towards("8.8.8.8")
        print(f"[dry-run] serving http://{ip}:{args.port}/stream — no speaker touched")
        print("[dry-run] Ctrl-C to stop.")
    else:
        target = choose_target(await find_targets(args.protocol), args.speaker, args.protocol)
        print(f"\n[target] {target.protocol}: {target.name}", flush=True)

        if target.protocol == "chromecast":
            cast = connect_chromecast(target.handle)
            ip = local_ip_towards(cast.cast_info.host)
            await run_chromecast(probe, cast, ip, args.port, args.duration)
            print(probe.summary(), flush=True)
            return

        if target.protocol == "dlna":
            device = target.handle
            host = device.device_url.split("//", 1)[1].split("/", 1)[0].split(":")[0]
            ip = local_ip_towards(host)
            sid = subscribe(
                device.service(_AVTRANSPORT).event_sub_url, f"http://{ip}:{args.port}/events"
            )
            print(f"[upnp] AVTransport subscription: {sid or 'FAILED — no reports will arrive'}")
            if await dispatch_dlna(probe, device, ip, args.port) is None:
                print("\n[result] The renderer refused the dispatch — nothing to measure.")
            else:
                print("\nWatching for ICY markers (unlikely, see the module docstring's")
                print("DLNA note) and polling GetPositionInfo in parallel — whichever")
                print("actually produces something wins. By-ear check as with Sonos.\n")
                await run_dlna_position(
                    probe,
                    device.service(_AVTRANSPORT),
                    f"http://{ip}:{args.port}/stream",
                    args.duration,
                )
                print(probe.summary(), flush=True)
                return
        else:
            device = target.handle
            ip = local_ip_towards(device.ip_address)
            sid = subscribe(
                f"http://{device.ip_address}:1400/MediaRenderer/AVTransport/Event",
                f"http://{ip}:{args.port}/events",
            )
            print(f"[upnp] AVTransport subscription: {sid or 'FAILED — no reports will arrive'}")

            if args.uri_variant:
                found = await dispatch_variant(probe, device, ip, args.port, args.uri_variant)
            else:
                found = await cycle_variants(probe, device, ip, args.port, args.window)
            if found is None:
                print("\n[result] No dispatch variant made this speaker ask for ICY.")
                print("[result] Ctrl-C for the summary — the injection approach is out.")
            else:
                print(f"\n[result] {found} got the speaker to ask for ICY. Staying on it.\n")
                print("Listen to the speaker. Each '>>> ... <<<' line below should land")
                print("at the instant the tone switches on or off.\n")

    async with server:
        try:
            await server.serve_forever()
        except asyncio.CancelledError:
            pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    if _PROBE is not None:
        print(_PROBE.summary(), flush=True)
