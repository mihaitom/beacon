# Plan: beatmix for pop and classic rock

Status: done, shipped in 1.9.0 (2026-10-18) - measurements, changes and
listening rounds are in
[investigations/transitions/beatmix-pop-rock-hip-hop.md](../investigations/transitions/beatmix-pop-rock-hip-hop.md).
Hip hop is in scope too. Follows
[gapless-and-transitions.md](gapless-and-transitions.md).

## Why

The beatmix sounds right on electronic music and "so-so" on pop and
classic rock. Nothing has been measured yet; the causes below are read out
of the code, and the first step is to find out which of them it really is.

## Suspected causes

Most likely first:

1. **The songs are not built to be mixed.** Electronic tracks have 16-32
   bars of drums and bass at either end. Pop and rock sing almost to the
   end and start singing again after a few bars, so an 8-bar overlap
   (~17 s at 110 BPM) puts two voices and two chord progressions on top of
   each other. A matched beat does not save that. Keys are not checked
   either - inaudible on a kick loop, obvious on guitars and vocals.
2. **A drummer without a click drifts.** `beat_grid()` fits one fixed
   period over the whole 60 s stretch. A drift of 1-3 % puts the grid
   20-40 ms off the real beat where the mix happens; around 12 ms is where
   a flam is heard. Either confidence drops (crossfade instead) or it
   passes just barely and the mix stumbles.
3. **The downbeat is the beat with the most kick.** Rock plays the kick on
   1 and 3 about alike (snare on 2 and 4), so the bass swap can land half a
   bar off and the phrase tips over. Four-on-the-floor is just as
   ambiguous, but there every beat sounds the same.
4. **Stretching up to 8 %** is inaudible on drum loops and audible on
   sustained vocals and guitars.

## Step 1: a tool to measure with

A debug endpoint (`routes/debug.py`) or a `uv run` script that takes two
song ids and:

- runs `analyse_region()` on both exactly as `mix_engine.py` does (same
  windows, same BPM hint) and prints the grid (BPM, confidence, downbeat
  confidence), sound bounds and beat bounds;
- runs `plan_transition()` with the current settings and prints the plan
  (kind, `no_beatmix`, bars, stretch rate, where the swap falls);
- renders the transition through the real mix engine into a WAV, a few
  bars either side, to listen to.

Ideally also a click track over the WAV at the grid's beats (left
channel), so a drifting grid or a wrong downbeat can be heard straight
away instead of guessed at.

## Step 2: measure

5-10 pairs each of pop and classic rock (some with fade-outs, some with
hard endings, some live), plus 2-3 electronic pairs as the reference.
Per pair, write down:

- beatmix or crossfade, and why;
- does the grid sit on the beat at the overlap (click track);
- is the downbeat right;
- what sounds wrong: flam, mush of two voices, wrong moment, stretch.

Results go in `docs/investigations/transitions/beatmix-pop-rock-hip-hop.md`, including the
causes that turn out not to matter.

## Step 3: fix what the measurement points at

Candidates, in the order they are expected to matter. Only what step 2
backs up gets built:

- **Overlap length from the song itself.** Measure whether the outgoing
  song's end and the incoming song's start have a stretch without vocals
  and melody (mid-band energy against the beat bars, or how much the
  chroma moves). Only then the full set bar count; otherwise 1-2 bars,
  still on the beat - how a DJ mixes pop. From the signal, not the genre
  tag: tags are too unreliable.
- **Local grid for drifting tempos.** Fit the period only over the last
  16-ish bars before the mix point (and the first ones of the incoming
  song), not over the whole 60 s; or real beat tracking (dynamic
  programming, Ellis 2007) instead of one fixed period. Long overlaps
  between two live drummers cannot be kept in step anyway - this pairs
  with the point above.
- **Downbeat from chord changes**: chords mostly change on the one; a
  chroma novelty curve folded onto the four beat classes, combined with
  the kick. The standard approach.
- **Key check**: chroma-based key estimate; keys that clash get a shorter
  blend.
- **Less stretch for tonal music**, e.g. 4 % instead of 8 % where the
  outgoing end is not drums-only.

Every change keeps the electronic reference pairs from step 2 as they are:
they work now and must keep working.

## Questions for the user

- What does "so-so" sound like: a stumbling beat / doubled kicks, two
  voices mushed together, the change at the wrong moment, the old song
  wobbling before the change - or does Now Playing often say "Crossfade"
  instead of "DJ mix"?
- A few concrete pairs that sounded bad, to start step 2 with.
