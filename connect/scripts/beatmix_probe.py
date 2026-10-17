"""scripts/beatmix_probe.py — what a beatmix between two real songs does,
and whether it should (docs/plans/beatmix-pop-rock.md, step 1).

For a pair of songs from the Subsonic test server (SUBSONIC_TEST_* in
.env), exactly as the mix engine does it:

  1. analyses the end of the outgoing song and the start of the incoming
     one (core/mix_engine.py's windows and BPM hint, core/beat_analysis.py)
     and prints each grid, its sound and beat bounds;
  2. plans the transition (core/transition_planner.py) and prints the plan;
  3. measures, bar by bar around the mix, how far each song's real onsets
     sit from its grid, and what that makes the flam between the two kicks
     in the overlap - the one number that says whether the beat stumbles;
  4. looks up where the incoming song's singing starts, as the app does
     (its first synced lyric line, routes/lyrics.py) - --no-lyrics skips it;
  5. with --wav-dir, renders the transition through the real MixEngine
     into two WAVs: the mix as it plays, and the same with a click track
     - the outgoing grid in the left ear, the incoming one in the right,
     higher on each downbeat - so a drifting grid or a wrong downbeat is
     heard rather than guessed at.

    uv run python scripts/beatmix_probe.py OUT_ID IN_ID --wav-dir /tmp/mix
    uv run python scripts/beatmix_probe.py --genre "Classic Rock" --pairs 8

--genre picks random songs of that genre and pairs them up, one summary
line per pair. Touches no production state: nothing is cast, nothing is
written but the WAVs.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import random
import secrets
import sys
import urllib.parse
import urllib.request
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from dotenv import dotenv_values

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.beat_analysis import (
    _ENVELOPE_OFFSET,
    _FPS,
    ANALYSIS_RATE,
    BeatGrid,
    RegionAnalysis,
    analyse_region,
    onset_envelopes,
)
from core.mix_engine import MixEngine, MixItem, _analysis_windows, song_label
from core.mix_timeline import SAMPLE_RATE
from core.streamer import pcm_decode_cmd
from core.transition_planner import (
    Settings,
    SongFacts,
    TransitionPlan,
    plan_transition,
    song_seconds,
)
from routes.lyrics import first_sung_line

SR = SAMPLE_RATE
# Rendered before the plan takes over and after the overlap ends.
CONTEXT_SECONDS = 8.0
# How far from its grid beat an onset is still that beat's.
_SEARCH_SECONDS = 0.07
# An envelope peak below this (in the envelope's std units) is no onset -
# the beat is not played there.
_ONSET_MIN = 1.0
# Mids for the rough "is anybody singing" reading: where voice, guitars
# and keys sit, above the kick and below the cymbals.
_MID_BAND = (300.0, 3000.0)
FLAM_SECONDS = 0.012


# ── The server ─────────────────────────────────────────────────────────────


class Subsonic:
    def __init__(self, env: dict) -> None:
        self.base = env["SUBSONIC_TEST_URL"].rstrip("/")
        self.user = env["SUBSONIC_TEST_USER"]
        self.password = env["SUBSONIC_TEST_PASSWORD"]

    def _query(self, **params) -> str:
        salt = secrets.token_hex(6)
        token = hashlib.md5((self.password + salt).encode()).hexdigest()
        auth = {"u": self.user, "t": token, "s": salt, "v": "1.16.1", "c": "beatmix-probe"}
        return urllib.parse.urlencode({**auth, **params})

    def call(self, method: str, **params) -> dict:
        url = f"{self.base}/rest/{method}?{self._query(f='json', **params)}"
        with urllib.request.urlopen(url, timeout=20) as r:
            body = json.load(r)["subsonic-response"]
        if body.get("status") != "ok":
            raise RuntimeError(f"{method}: {body.get('error')}")
        return body

    def song(self, song_id: str) -> dict:
        return self.call("getSong", id=song_id)["song"]

    def songs_by_genre(self, genre: str, count: int) -> list[dict]:
        return self.call("getSongsByGenre", genre=genre, count=count)["songsByGenre"].get(
            "song", []
        )

    def stream_url(self, song_id: str) -> str:
        return f"{self.base}/rest/stream?{self._query(id=song_id, format='raw')}"


def mix_item(song: dict, index: int) -> MixItem:
    return MixItem(
        song_id=song["id"],
        queue_index=index,
        duration=float(song.get("duration") or 0),
        album_id=song.get("albumId"),
        disc=song.get("discNumber"),
        track=song.get("track"),
        bpm=song.get("bpm") or None,
        label=song_label(song.get("artist"), song.get("title")),
        artist=song.get("artist"),
        title=song.get("title"),
        album=song.get("album"),
    )


async def decode(url: str, start: float, duration: float | None, channels: int, rate: int):
    proc = await asyncio.create_subprocess_exec(
        *pcm_decode_cmd(url, max(start, 0.0), duration, channels=channels, rate=rate),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    data, _ = await proc.communicate()
    x = np.frombuffer(data[: len(data) // (2 * channels) * 2 * channels], dtype="<i2")
    return x.reshape(-1, channels).astype(np.float32) / 32768.0


# ── Measuring ──────────────────────────────────────────────────────────────


@dataclass
class Region:
    analysis: RegionAnalysis
    # The same stretch, mono at ANALYSIS_RATE, as the analysis saw it.
    samples: np.ndarray


def onset_deviation(region: Region, beats: np.ndarray) -> np.ndarray:
    """Seconds from each grid beat (song time) to the real onset nearest it,
    NaN where nothing is played on that beat."""
    full, _ = onset_envelopes(region.samples)
    out = np.full(len(beats), np.nan)
    reach = int(_SEARCH_SECONDS * _FPS)
    for i, b in enumerate(beats):
        centre = round((b - region.analysis.start - _ENVELOPE_OFFSET) * _FPS)
        lo, hi = max(centre - reach, 1), min(centre + reach + 1, len(full) - 1)
        if hi - lo < 3:
            continue
        j = lo + int(np.argmax(full[lo:hi]))
        if full[j] < _ONSET_MIN:
            continue
        a, c = full[j - 1], full[j + 1]
        denom = a - 2 * full[j] + c
        frac = 0.5 * (a - c) / denom if denom != 0 else 0.0
        out[i] = (j + frac) / _FPS + _ENVELOPE_OFFSET + region.analysis.start - b
    return out


def mids_db(region: Region, bar_starts: np.ndarray, bar: float) -> np.ndarray:
    """Each bar's level in _MID_BAND against the stretch's loud bars (75th
    percentile of all its bars), in dB. Rough: near 0 the song is in full
    flight there, well below it is thinned out to drums and bass."""
    x = region.samples
    spectrum = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / ANALYSIS_RATE)
    spectrum[(f < _MID_BAND[0]) | (f > _MID_BAND[1])] = 0
    mids = np.fft.irfft(spectrum, len(x))

    def level(t0: float) -> float:
        a = int((t0 - region.analysis.start) * ANALYSIS_RATE)
        b = int(a + bar * ANALYSIS_RATE)
        a, b = max(a, 0), min(b, len(mids))
        return 10 * np.log10(np.mean(mids[a:b] ** 2) + 1e-12) if b > a else np.nan

    grid = region.analysis.grid
    assert grid is not None
    every = grid.downbeats(region.analysis.start, region.analysis.end - bar)
    typical = np.nanpercentile([level(t) for t in every], 75) if len(every) else 0.0
    return np.array([level(t) - typical for t in bar_starts])


def describe_region(name: str, r: RegionAnalysis, item: MixItem) -> None:
    print(f"  {name}: {item.name}  [{item.duration:.0f}s, server bpm {item.bpm or '-'}]")
    print(
        f"    analysed {r.start:.1f}-{r.end:.1f}s, sound {r.sound_start:.1f}-{r.sound_end:.1f}s,"
        f" beat {_t(r.beat_start)}-{_t(r.beat_end)}"
    )
    g = r.grid
    if g is None:
        print("    no grid")
    else:
        print(
            f"    grid {g.bpm:.2f} BPM, confidence {g.confidence:.2f},"
            f" downbeat {g.downbeat:.3f}s (confidence {g.downbeat_confidence:.2f})"
        )


def _t(x: float | None) -> str:
    return "-" if x is None else f"{x:.1f}s"


def describe_plan(plan: TransitionPlan) -> None:
    rate = plan.out_rate[-1][1] if plan.out_rate else 1.0
    line = f"  plan: {plan.kind}"
    if plan.no_beatmix:
        line += f" ({plan.no_beatmix})"
    print(line)
    if plan.kind == "gapless":
        return
    bars = ""
    if plan.kind == "beatmix" and plan.bpm_out:
        bars = f" = {plan.overlap * rate / (240 / plan.bpm_out):.0f} bars"
    print(
        f"    out {plan.out_start:.2f}-{plan.out_end:.2f}s, in from {plan.in_start:.2f}s,"
        f" overlap {plan.overlap:.2f}s{bars}, swap at +{plan.swap_at:.2f}s"
    )
    if plan.out_rate:
        ease = -plan.out_rate[0][0] if plan.out_rate[0][0] < 0 else 0.0
        print(
            f"    stretch {100 * (rate - 1):+.2f} % (ease over {ease:.1f}s from {plan.stretch_start:.2f}s)"
        )


@dataclass
class Fit:
    """Bar by bar through the overlap (and a few bars of the outgoing song
    before it): each grid's median onset deviation, and the flam."""

    rows: list[tuple]
    flam: np.ndarray

    @property
    def flam_median(self) -> float:
        f = self.flam[~np.isnan(self.flam)]
        return float(np.median(np.abs(f))) if len(f) else float("nan")

    @property
    def flam_worst(self) -> float:
        f = self.flam[~np.isnan(self.flam)]
        return float(np.max(np.abs(f))) if len(f) else float("nan")


def measure_fit(plan: TransitionPlan, out: Region, inn: Region, before_bars: int = 4) -> Fit:
    og, ig = out.analysis.grid, inn.analysis.grid
    assert og is not None and ig is not None
    rate = plan.out_rate[-1][1] if plan.out_rate else 1.0
    bar = 4 * og.period
    first = max(plan.out_start - before_bars * bar, out.analysis.start)
    starts = og.downbeats(first - 0.01, plan.out_end - bar + 0.01)
    rows, flams = [], []
    out_mids = mids_db(out, starts, bar)
    for k, s in enumerate(starts):
        beats = s + np.arange(4) * og.period
        dev_out = onset_deviation(out, beats)
        in_dev = np.full(4, np.nan)
        in_mid = np.nan
        if s >= plan.out_start - 0.01:
            # The incoming beats laid over these in the stream: the
            # outgoing song plays at `rate`, the incoming one untouched.
            t = (beats - plan.out_start) / rate
            in_beats = plan.in_start + t
            # Its own grid's beats nearest those points - which is what the
            # plan lined up.
            in_beats = ig.phase + np.round((in_beats - ig.phase) / ig.period) * ig.period
            in_dev = onset_deviation(inn, in_beats)
            in_mid = mids_db(inn, in_beats[:1], 4 * ig.period)[0]
            flams.extend((dev_out / rate) - in_dev)
        rows.append((k, s, dev_out, in_dev, out_mids[k], in_mid, s >= plan.out_start - 0.01))
    return Fit(rows, np.array(flams))


def print_fit(fit: Fit, plan: TransitionPlan) -> None:
    print("    bar   out@s     out grid→onset ms        in grid→onset ms       mids out/in dB")
    swap_song = plan.out_start + song_seconds(plan.out_rate, 0.0, plan.swap_at)
    for k, s, dev_out, dev_in, m_out, m_in, inside in fit.rows:
        mark = ">" if inside else " "
        if inside and abs(s - swap_song) < 0.05:
            mark = "S"
        print(
            f"  {mark} {k:3d}  {s:7.2f}   {_devs(dev_out)}   {_devs(dev_in)}"
            f"   {m_out:5.1f} / {'' if np.isnan(m_in) else f'{m_in:.1f}'}"
        )
    print(
        f"    flam in overlap: median {1000 * fit.flam_median:.1f} ms,"
        f" worst {1000 * fit.flam_worst:.1f} ms (heard from ~{1000 * FLAM_SECONDS:.0f} ms)"
    )


def _devs(d: np.ndarray) -> str:
    return " ".join("   ." if np.isnan(x) else f"{1000 * x:+4.0f}" for x in d) + "  "


# ── Rendering ──────────────────────────────────────────────────────────────


class MemoryDeck:
    """A deck over audio decoded up front, from `offset` seconds of its song."""

    def __init__(self, item: MixItem, start: float, pcm: np.ndarray, offset: float) -> None:
        self.item = item
        self.start = start
        skip = max(0, round((start - offset) * SR))
        self._buf = bytearray((np.clip(pcm[skip:], -1, 1) * 32767).astype("<i2").tobytes())
        self.produced = bool(self._buf)
        self.decoder_done = True
        self._consumed = 0

    @property
    def position(self) -> float:
        return self.start + self._consumed / SR

    @property
    def finished(self) -> bool:
        return not self._buf

    @property
    def available(self) -> int:
        return len(self._buf) // 4

    def open(self) -> None:
        pass

    def close(self) -> None:
        pass

    def take(self, frames: int) -> bytes:
        n = min(frames * 4, len(self._buf))
        out = bytes(self._buf[:n])
        del self._buf[:n]
        self._consumed += n // 4
        return out

    def discard(self, frames: int) -> None:
        frames = max(frames, 0)  # as Deck: a negative skip skips nothing
        del self._buf[: min(frames * 4, len(self._buf))]
        self._consumed += frames


class Clock:
    now = 1000.0

    def __call__(self) -> float:
        return self.now


async def render(
    settings: Settings,
    out_item: MixItem,
    in_item: MixItem,
    plan: TransitionPlan,
    regions: tuple[RegionAnalysis, RegionAnalysis],
    urls: tuple[str, str],
    vocals: float | None = None,
) -> tuple[np.ndarray, float, MixEngine]:
    """The transition as the engine plays it, from CONTEXT_SECONDS before
    the plan takes over; (stereo audio, where in the outgoing song it
    starts, the engine for its timeline)."""
    begin = max(0.0, plan.stretch_start - CONTEXT_SECONDS)
    in_until = plan.in_start + plan.overlap + CONTEXT_SECONDS
    out_pcm, in_pcm = await asyncio.gather(
        decode(urls[0], begin, None, 2, SR), decode(urls[1], 0.0, in_until, 2, SR)
    )
    pcms = {out_item.song_id: (out_pcm, begin), in_item.song_id: (in_pcm, 0.0)}
    # A song paired with itself would be one deck for both ends.
    assert out_item.song_id != in_item.song_id

    async def next_fn(current: MixItem) -> MixItem | None:
        return in_item if current.song_id == out_item.song_id else None

    async def analyse_fn(item: MixItem, start: float, duration: float):
        return regions[0] if item.song_id == out_item.song_id else regions[1]

    async def url_fn(item: MixItem) -> str:
        return item.song_id

    async def vocals_fn(item: MixItem) -> float | None:
        return vocals if item.song_id == in_item.song_id else None

    clock = Clock()
    engine = MixEngine(
        out_item,
        begin,
        url_fn,
        next_fn,
        lead_seconds=2.0,
        clock=clock,
        deck_factory=lambda item, start: MemoryDeck(item, start, *pcms[item.song_id]),
        settings=settings,
        analyse_fn=analyse_fn,
        vocals_fn=vocals_fn,
    )
    engine.start()
    raw = bytearray()
    for _ in range(20000):
        engine.step()
        ring = engine.ring
        raw += ring.read(len(raw) // 4, ring.head - len(raw) // 4)
        for _ in range(5):
            await asyncio.sleep(0)
        clock.now += 0.5
        if engine.ended:
            break
    engine.stop()
    audio = np.frombuffer(bytes(raw), dtype="<i2").reshape(-1, 2).astype(np.float32) / 32768
    return audio, begin, engine


def overlap_start_frame(engine: MixEngine, plan: TransitionPlan, in_id: str) -> float | None:
    """Where in the stream the overlap began, from where the timeline has
    the incoming song take over - at swap_at into it."""
    for entry in engine.timeline.entries:
        if entry.song_id == in_id and entry.starts:
            return entry.frame - (entry.position - plan.in_start) * SR
    return None


def click(hz: float, level: float) -> np.ndarray:
    n = np.arange(int(0.03 * SR))
    return level * np.sin(2 * np.pi * hz * n / SR) * np.exp(-n / (0.004 * SR))


def add_clicks(track: np.ndarray, times: np.ndarray, downbeats: np.ndarray, hz: float) -> None:
    for t in times:
        i = round(t * SR)
        if i < 0 or i >= len(track):
            continue
        down = np.min(np.abs(downbeats - t)) < 0.01 if len(downbeats) else False
        c = click(hz * (1.5 if down else 1.0), 0.5 if down else 0.3)
        track[i : i + len(c)] += c[: len(track) - i]


def song_to_stream(plan: TransitionPlan, t0: float, song_times: np.ndarray) -> np.ndarray:
    """Stream seconds at which the outgoing song plays each of `song_times`,
    t0 being the overlap's start in the stream."""
    span = np.linspace(-200.0, plan.overlap, 20001)
    song = plan.out_start + np.array([song_seconds(plan.out_rate, 0.0, x) for x in span])
    return t0 + np.interp(song_times, song, span, left=np.nan, right=np.nan)


def with_clicks(
    audio: np.ndarray, plan: TransitionPlan, t0: float, og: BeatGrid, ig: BeatGrid
) -> np.ndarray:
    mono = audio.mean(axis=1) * 0.8
    left, right = mono.copy(), mono.copy()
    length = len(audio) / SR
    # The outgoing grid until the overlap ends, in stream time.
    song_span = (plan.out_start - 200.0, plan.out_end)
    out_beats = song_to_stream(plan, t0, og.beats(*song_span))
    out_downs = song_to_stream(plan, t0, og.downbeats(*song_span))
    add_clicks(left, out_beats[~np.isnan(out_beats)], out_downs[~np.isnan(out_downs)], 2000.0)
    # The incoming grid from the overlap on.
    in_span = (plan.in_start - 0.01, plan.in_start + length - t0)
    shift = t0 - plan.in_start
    add_clicks(right, ig.beats(*in_span) + shift, ig.downbeats(*in_span) + shift, 1500.0)
    return np.stack([left, right], axis=1)


def write_wav(path: Path, audio: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())


# ── One pair ───────────────────────────────────────────────────────────────


@dataclass
class Result:
    out_item: MixItem
    in_item: MixItem
    plan: TransitionPlan
    regions: tuple[RegionAnalysis, RegionAnalysis]
    fit: Fit | None


async def probe(
    server: Subsonic,
    settings: Settings,
    out_song: dict,
    in_song: dict,
    wav_dir: Path | None,
    verbose: bool,
    use_lyrics: bool = True,
) -> Result | None:
    out_item, in_item = mix_item(out_song, 0), mix_item(in_song, 1)
    urls = (server.stream_url(out_item.song_id), server.stream_url(in_item.song_id))
    (os_, od), (is_, id_) = _analysis_windows(out_item, in_item)
    out_r, in_r, out_s, in_s, vocals = await asyncio.gather(
        analyse_region(urls[0], os_, od, out_item.bpm),
        analyse_region(urls[1], is_, id_, in_item.bpm),
        decode(urls[0], os_, od, 1, ANALYSIS_RATE),
        decode(urls[1], is_, id_, 1, ANALYSIS_RATE),
        first_sung_line(in_item) if use_lyrics else asyncio.sleep(0, None),
    )
    if out_r is None or in_r is None:
        print(f"  could not analyse {out_item.name} / {in_item.name}")
        return None
    facts = (
        SongFacts(out_item.until, out_item.album_id, out_item.disc, out_item.track),
        SongFacts(in_item.until, in_item.album_id, in_item.disc, in_item.track),
    )
    plan = plan_transition(settings, *facts, out_r, in_r, vocals)
    fit = None
    if plan.kind == "beatmix":
        fit = measure_fit(plan, Region(out_r, out_s[:, 0]), Region(in_r, in_s[:, 0]))
    if verbose:
        describe_region("out", out_r, out_item)
        describe_region("in ", in_r, in_item)
        print(f"    incoming singing starts at {_t(vocals)} (synced lyrics)")
        describe_plan(plan)
        if fit is not None:
            print_fit(fit, plan)
    if wav_dir is not None and plan.kind != "gapless":
        audio, _, engine = await render(
            settings, out_item, in_item, plan, (out_r, in_r), urls, vocals
        )
        stem = _slug(f"{out_item.name}__{in_item.name}")
        wav_dir.mkdir(parents=True, exist_ok=True)
        write_wav(wav_dir / f"{stem}.wav", audio)
        frame = overlap_start_frame(engine, plan, in_item.song_id)
        if frame is not None and out_r.grid and in_r.grid:
            t0 = frame / SR
            write_wav(
                wav_dir / f"{stem}.clicks.wav",
                with_clicks(audio, plan, t0, out_r.grid, in_r.grid),
            )
            if verbose:
                print(f"    wav: {wav_dir / stem}.wav (+ .clicks.wav), overlap at {t0:.1f}s")
        elif verbose:
            print(f"    wav: {wav_dir / stem}.wav")
    return Result(out_item, in_item, plan, (out_r, in_r), fit)


def _slug(s: str) -> str:
    keep = "".join(c if c.isalnum() or c in "-_" else "_" for c in s)
    return keep[:120]


def summary_line(r: Result) -> str:
    og, ig = r.regions[0].grid, r.regions[1].grid

    def g(x: BeatGrid | None) -> str:
        return (
            "  no grid      "
            if x is None
            else f"{x.bpm:6.1f} {x.confidence:.2f}/{x.downbeat_confidence:.2f}"
        )

    kind = r.plan.kind + (f"/{r.plan.no_beatmix}" if r.plan.no_beatmix else "")
    extra = ""
    if r.fit is not None:
        rate = r.plan.out_rate[-1][1] if r.plan.out_rate else 1.0
        bars = r.plan.overlap * rate / (4 * og.period) if og else 0
        extra = (
            f" {bars:3.0f} bars {100 * (rate - 1):+5.1f}%"
            f" flam {1000 * r.fit.flam_median:4.1f}/{1000 * r.fit.flam_worst:5.1f}ms"
        )
    return f"{kind:<24} {g(og)} | {g(ig)}{extra}  {r.out_item.name} → {r.in_item.name}"


# Server BPMs this close (or at double/half) are paired; a little inside
# MAX_STRETCH, since the server's number is not the analysis's.
_PAIR_TEMPO = 0.06


def pair_up(songs: list[dict], count: int, any_tempo: bool) -> list[tuple[dict, dict]]:
    """Pairs a queue might hold, of different albums - by default only
    ones whose tempos are close enough for a beatmix to be planned, which
    is what is to be measured."""
    pool = list(songs)
    pairs = []
    while pool and len(pairs) < count:
        a = pool.pop(0)
        for i, b in enumerate(pool):
            if b.get("albumId") == a.get("albumId"):
                continue
            if any_tempo or _close(a.get("bpm"), b.get("bpm")):
                pairs.append((a, pool.pop(i)))
                break
    return pairs


def _close(a: float | None, b: float | None) -> bool:
    if not a or not b:
        return False
    return any(abs(a / (b * f) - 1) <= _PAIR_TEMPO for f in (1.0, 2.0, 0.5))


async def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("ids", nargs="*", help="outgoing and incoming song id")
    p.add_argument("--genre", help="pair up random songs of this genre instead")
    p.add_argument("--pairs", type=int, default=6)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument(
        "--any-tempo", action="store_true", help="pair at random, not by the server's BPM"
    )
    p.add_argument("--bars", type=int, default=16, help="the beatmix bars setting (default 16)")
    p.add_argument("--crossfade", type=float, default=10.0, help="crossfade seconds (default 10)")
    p.add_argument("--wav-dir", type=Path, default=None)
    p.add_argument("-v", "--verbose", action="store_true", help="details for --genre pairs too")
    p.add_argument("--no-lyrics", action="store_true", help="plan without where the singing starts")
    args = p.parse_args()

    env = dotenv_values(Path(__file__).resolve().parent.parent / ".env")
    server = Subsonic(env)
    settings = Settings("crossfade", args.crossfade, args.bars)

    if args.genre:
        songs = server.songs_by_genre(args.genre, 500)
        rng = random.Random(args.seed)
        rng.shuffle(songs)
        pairs = pair_up(songs, args.pairs, args.any_tempo)
    elif len(args.ids) == 2:
        pairs = [(server.song(args.ids[0]), server.song(args.ids[1]))]
    else:
        p.error("give two song ids, or --genre")

    single = not args.genre
    results = []
    for out_song, in_song in pairs:
        if single or args.verbose:
            print(
                f"\n{out_song.get('artist')} — {out_song.get('title')} [{out_song['id']}]"
                f"  →  {in_song.get('artist')} — {in_song.get('title')} [{in_song['id']}]"
            )
        r = await probe(
            server,
            settings,
            out_song,
            in_song,
            args.wav_dir,
            single or args.verbose,
            not args.no_lyrics,
        )
        if r is not None:
            results.append(r)
            if not single:
                print(summary_line(r), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
