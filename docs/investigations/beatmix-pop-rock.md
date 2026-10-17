# Beatmix on pop, classic rock and hip hop - OPEN

Started 2026-10-17, from [the plan](../plans/beatmix-pop-rock.md). The
beatmix sounds right on electronic music and "so-so" on pop, classic rock
and hip hop. Asked what "so-so" sounds like, the answer was two things:
**two voices / two chord progressions mushed together**, and **a stumbling
beat, doubled kicks**. Not the change at the wrong moment, not "it says
Crossfade too often".

## The tool

`connect/scripts/beatmix_probe.py` runs a pair of songs from the Subsonic
test server through exactly what the mix engine does - the same analysis
windows and BPM hint, `analyse_region()`, `plan_transition()` - and then:

- measures, beat by beat from four bars before the overlap to its end, how
  far each song's real onset sits from its grid, and from that the flam
  between the two kicks in the overlap;
- with `--wav-dir`, renders the transition through the real `MixEngine`
  (in-memory decks, a fake clock) into `<pair>.wav` and `<pair>.clicks.wav`:
  outgoing grid in the left ear, incoming in the right, higher on the
  downbeat.

```bash
cd connect
uv run python scripts/beatmix_probe.py OUT_ID IN_ID --wav-dir /tmp/mix
uv run python scripts/beatmix_probe.py --genre "Classic Rock" --pairs 10 --seed 7 -v
```

`--genre` pairs random songs of a genre by the server's BPM (within 6 %,
double and half included), since pairs further apart only ever crossfade
and there is nothing to measure.

Checked against itself: on a rendered WAV the clicks sit on the mix's own
onsets with a median of 0 ms (IQR ±5 ms) for both grids, so the click track
and the engine agree on where the beats are.

## Measurement 1: grids against real onsets (2026-10-17)

10 pairs each of Classic Rock, Pop, Hip Hop and Electronic, 8 each of House
and Trance, `--bars 16 --seed 7`. The library's "Electronic" tag turned out
to hold a lot of pop (Peter Gabriel, Robin Gibb, The Clash), so House +
Trance is the reference, not Electronic.

Per beat in the overlap, |outgoing deviation - incoming deviation|:

| Set          | beats | median |   p75 | > 12 ms | > 25 ms |
| ------------ | ----: | -----: | ----: | ------: | ------: |
| House+Trance |   461 | 6.0 ms | 13 ms |    25 % |    10 % |
| Electronic   |   365 | 6.0 ms | 13 ms |    26 % |     8 % |
| Pop          |   392 | 9.0 ms | 24 ms |    43 % |    23 % |
| Hip Hop      |   280 |  10 ms | 24 ms |    41 % |    24 % |
| Classic Rock |   204 |  17 ms | 27 ms |    61 % |    27 % |

The House row is the floor of the method, not zero: the nearest onset to a
beat is sometimes a hi-hat or a synth stab rather than the kick, and the
envelope's hop is 5.8 ms. What sounds right sits at 6 ms median; classic
rock at almost three times that, with most beats past the ~12 ms where a
flam is heard. **The stumbling beat is real and measurable**, worst on rock,
pop and hip hop roughly in between.

### What the error is - and is not

Per song, the deviations through the overlap were fitted three ways (median
|residual|):

| Set          | raw     | minus a constant offset | minus a linear trend |
| ------------ | ------- | ----------------------- | -------------------- |
| House+Trance | 3.0 ms  | 3.0 ms                  | 3.8 ms               |
| Pop          | 5.0 ms  | 5.0 ms                  | 5.7 ms               |
| Hip Hop      | 6.0 ms  | 5.5 ms                  | 7.6 ms               |
| Classic Rock | 10.5 ms | 10.5 ms                 | 10.4 ms              |

**Ruled out: drift of the fixed grid against the song** (suspected cause 2
as written in the plan). Neither a phase offset nor a local tempo fitted
over the overlap itself brings rock's error down - the grid sits on the
average beat already. What is left is beat-to-beat timing: a drummer's
push and drag around a steady average. A "local grid" (step 3, second
candidate) would fit that average again and change nothing; following it
would take a stretch that warps beat by beat.

### Side findings

- **The halves check refuses a lot.** 15 of 112 grids came out at exactly
  confidence 0.30 - the two halves of the stretch put the beat more than
  25 ms apart - and most `unsure_beat` crossfades are that, not a weak
  fold. Across genres, Trance included (DJ compilations, The Weeknd).
  Not looked into yet whether those are real tempo changes or a period off
  by a hair.
- **Downbeat confidence is low almost everywhere**, House included (median
  around 0.15-0.3, many under 0.1), and the planner does not look at it.
  Whether that puts the bass swap half a bar off has to be heard (clicks
  WAV); the numbers alone do not say.
- **Wrong meter goes through.** John Legend - Everybody Knows (90 BPM)
  into Leonard Cohen - Hallelujah (6/8, read as 168.8 = 2 x 84.4) was
  planned as a 16-bar beatmix at -6.2 %.

### Not answered by this measurement

The mush. The mid-band reading (300-3000 Hz per bar against the song's
loud bars) stays within a dB of full flight at the overlap for every set,
House included, so it cannot tell a sung verse from a synth riff. Whether
the overlap lands on vocals has to be heard, or measured with something
that actually picks out a voice.

## Listening shortlist

Rendered with `--bars 16 --seed 7 --wav-dir`; the probe reproduces each
from its genre run or from the two ids.

| Pair                                                              | Set        | flam median | Why it is on the list          |
| ----------------------------------------------------------------- | ---------- | ----------: | ------------------------------ |
| Cozy Powell - Na Na Na → Deep Purple - High Ball Shooter          | Rock       |       28 ms | worst flam                     |
| Axis - Ela Ela → Eric Clapton - I Shot the Sheriff                | Rock       |       18 ms | rock, +3.3 % stretch           |
| John Fogerty - Hearts of Stone → Aerosmith - Walk This Way        | Rock       |       13 ms | +5.8 % stretch                 |
| James Morrison - Demons → Rita Ora - Let You Love Me              | Pop        |       22 ms | vocals both sides              |
| John Legend - Everybody Knows → Leonard Cohen - Hallelujah        | Pop        |       36 ms | 6/8 into 4/4                   |
| Fergie - Losing My Ground → Eno - Ferrari                         | Hip Hop    |       20 ms | rap over rap                   |
| Kris Kross - Warm It Up → P!nk - Just Like a Pill                 | Hip Hop    |        6 ms | tight grid: mush without flam? |
| Peter Gabriel - Steam → Aretha Franklin - I Knew You Were Waiting | Pop        |        4 ms | tight grid, two voices         |
| Eric Prydz - Proper Edication → Duck Sauce - Barbra Streisand     | Electronic |        8 ms | reference                      |

## Listening 1 (2026-10-17)

Heard by the user, who can tell good from off but not name what is off -
so the notes below are in their words, and future rounds should ask
"A or B, which is better" rather than for a diagnosis. Rendered at 16
bars; the app's default is 8.

- Good: Black Eyed Peas → David Hanselmann (beatmix, nothing to fault);
  Was (Not Was) → Londonbeat (beatmix, "quite okay"); Alle Farben → Lady
  Gaga - Telephone (crossfade, fine, helped by Telephone's beatless intro).
- **Old song goes on too long after the change** - Bananarama → Nico &
  Vinz: good at first, then the voices pile up. The half of the overlap
  after the bass swap is too long.
- **Slowed down too far, with artefacts** - Color Me Badd → Lionel Richie,
  -6.2 %: "too slow", and the "fan noise" heard before from the stretch.
  Suspected cause 4 (stretch on tonal music) confirmed.
- **Too much at once** - We Will Rock You → Jeangu Macrooy: no regular kit
  to match, stomps, claps and crowd over the incoming song.
- **The songs do not go together** - James Morrison → Rita Ora; and the
  two crossfades Paul Johnson → Beachbag (voices over each other, not
  disturbing) and The Weeknd → Odd Mob. No mixing fixes that - but Beacon
  does not choose the order, the queue does, so what it can do is keep a
  bad match short.

Random pairs are mostly ones no DJ would play back to back; that is
realistic for a shuffled queue, but it means "does not fit" is common and
the answer to it is a short, unobtrusive transition, not a better match.

## Change 1 and listening 2 (2026-10-17)

Built: after the bass swap the outgoing song is gone within
`POST_SWAP_BARS` (2) instead of the other half of the bars set, so an
8-bar mix overlaps 6; and `MAX_STRETCH` 8 % → 5 %. The same nine pairs at
8 bars, old (A) against new (B), blind X/Y in random order:

| Pair                               | Verdict | Note                                                     |
| ---------------------------------- | ------- | -------------------------------------------------------- |
| Bananarama → Nico & Vinz           | **B**   |                                                          |
| Black Eyed Peas → David Hanselmann | A       | the longer tail ended just as the incoming vocals set in |
| Booty Luv → Pitbull                | same    |                                                          |
| Color Me Badd → Lionel Richie      | **B**   | B a crossfade (6.2 % apart); A slowed down too hard      |
| Depeche Mode → Felix Jaehn         | A       | both poor; **stretch artefacts at -4.5 % in both**       |
| Eric Prydz → Duck Sauce            | **B**   | both good, B a touch better                              |
| We Will Rock You → Jeangu Macrooy  | **B**   | B a crossfade (5.6 % apart): hardly noticed the change   |
| Lady Gaga → Bob Marley             | **B**   | both good, B a touch better                              |
| Was (Not Was) → Londonbeat         | **B**   | both okay                                                |

Six to two, one even, the electronic controls included. From it:

- The shorter fade after the swap stays. The one loss (Black Eyed Peas)
  is not about length but about where the mix ends: there the old,
  longer one happened to end where the incoming vocals begin. Ending on
  the incoming song's structure, not on a fixed count, is the idea in it -
  Mixxx's AutoDJ takes the shorter of outro and intro for the same reason.
- 4.5 % was still heard as artefacts, 2.4 % (Eric Prydz) clean:
  `MAX_STRETCH` went on to **3 %**. Whether the stretcher itself (WSOLA)
  could do 4-5 % cleanly is a separate question, not looked into.
- A crossfade where the tempos are far apart was preferred over the
  stretched beatmix both times it came up.

## Where the incoming singing starts (2026-10-17)

To end the overlap on the incoming vocals, Beacon has to know where they
start.

**Ruled out: finding it in the audio.** A numpy detector for "the
arrangement fills up" - per-bar band levels and chroma, novelty across a
downbeat, plus a rise in the mids - was checked against the first synced
lyric line of 60 well-known songs (15 per genre): it found the singing
within half a bar in **15 of 60**. The rest it missed, or it found the
drums coming in instead (Firework, Eye of the Tiger), or a near miss of a
bar or two. Telling a voice from a guitar takes a trained model (All-In-One
does it with PyTorch and source separation), which the bundled app cannot
carry.

**Built instead: the synced lyrics.** connect already looks lyrics up
(routes/lyrics.py, lrclib and the rest, with a cache);
`first_sung_line()` takes the first line with words, and the planner ends
the overlap on the incoming downbeat nearest it - up to four bars after
the swap, or, where it starts before the swap, by shortening the whole mix
to end there. A crossfade into singing ends where it starts, never shorter
than half its length. No synced lyrics: the mix stays as set. 14 of 16
well-known songs had them.

Built alongside: both songs' mids dip 6 dB around the swap (pyCrossfade's
figure), over a bar either side - a quarter of the length on a crossfade.

Noticed, not changed: an incoming song whose beat only sets in after an
intro joins late enough for it to land on the swap - which skips its
first seconds, singing included where it sings over the intro (Calvin
Harris - This Is What You Came For, sung from 0.1 s, joined at 7.8 s).

## Listening 3 (2026-10-17)

16 well-known pairs, four each of pop, classic rock, hip hop and
electronic, 8 bars, blind. A = change 1, B = plus the lyrics ending and the
mid dip. **B 8, A 2, even 6.** The two pairs where the lyrics moved the
end (Katy Perry - Firework, a shortened crossfade; Kylie Minogue, 7 bars
ending on the "la la la") both went to B; the two A wins (Uptown Funk →
Save Your Tears, Gin and Juice → Hypnotize) were mid dip only. The
listener said the differences were now hard to hear at all - the point
of diminishing returns for this round of changes.

- **Stretch artefacts below 2 %**: heard in both versions of Just Dance →
  Billie Jean (-1.8 %) and Gin and Juice → Hypnotize (-0.7 %). So the
  grain is not only the amount - the stretcher (core/timestretch.py,
  WSOLA) is audible on voices at any rate. Not looked into yet.
- **A bug found on the way** (pair 9, In da Club → Drop It Like It's
  Hot): a downbeat 30 ms before the incoming song's start was accepted
  as its join point, in the planner since 1.8.0. The engine's deck
  cannot start before 0, so the real mix played the whole overlap 30 ms
  off the beat; the probe's in-memory deck took the negative skip
  literally and dropped the song, which is how it showed. The join now
  takes the next downbeat inside the song.

## The stretcher (2026-10-17)

**Why WSOLA cannot get there.** Each frame gets one time offset, and the
match is dominated by the bass. Voice and chords repeat at other periods,
so at the splice they half-cancel and pump at the hop rate (43 Hz) - the
"fan". A smaller rate only makes splices rarer, not cleaner, which is why
-0.7 % was still heard.

**Ruled out as the fix: the match's normalisation.** `_best_fit()` divides
by the candidate's plain level while the reference is windowed, so the
natural continuation does not always win even when it is in range.
Weighting the level with the window halves the needless jumps at -0.7 %
(34 → 17 of 430 steps, synthetic voice + bass) and changes nothing at
-1.8 % or 3 %. Correct, but not what is heard.

**Candidates**, both with wheels for Windows, macOS x64/arm and Linux x64,
**none for Linux arm64** (which the desktop and Docker builds both need):
Rubber Band R3 (`pylibrb`, GPL - fine for Beacon's GPL-3.0, realtime
mode takes a changing ratio) and Signalsmith Stretch (`python-stretch`,
MIT). Wrapped behind Wsola's push/needed/pull interface for the probe,
primed with 16384 frames of history instead of one hop.

Checked before listening, with a click track over a tone bed:

- Timing against the rate integral: Signalsmith ±0.3 ms, Rubber Band
  ±5 ms (it buffers ~4000 input frames, which a rate change then plays at
  the new ratio), WSOLA ±9 ms (its own search tolerance). Neither library
  adds a flam.
- Both already align their output to the input once primed: adding
  `get_start_delay()` / the input+output latency on top put them 2045 and
  5286 frames early.
- Signalsmith via the binding drifts ~700 frames in 25 s unless every
  block's ratio is set to exactly in/out of that block - it rounds the
  output length per call.
- The `python-stretch` binding comes out a constant 4.07 dB down (music,
  noise, sine; rates 0.97-1.03). Compensated, or it would have given
  itself away in a blind test.
- Clicks come out softer from both (peak 0.46 / 0.38 against 0.74):
  transients are smeared, to be judged by ear.

**Listening 4**: 8 pairs from -4.5 % to +2.6 %, the three stretchers
blind as A/B/C, same plan, no lyrics (lrclib was answering 503), best and
worst per pair.

| Pair                                 | Rate   | Best                          | Worst                                 |
| ------------------------------------ | ------ | ----------------------------- | ------------------------------------- |
| Bananarama → Nico & Vinz             | -2.9 % | Rubber Band                   | WSOLA                                 |
| Black Eyed Peas → David Hanselmann   | -1.6 % | Rubber Band                   | Signalsmith                           |
| Depeche Mode → Felix Jaehn           | -4.5 % | Rubber Band                   | WSOLA (Signalsmith also poor)         |
| Eric Prydz → Duck Sauce              | +2.4 % | WSOLA (Rubber Band also good) | Signalsmith                           |
| Lady Gaga - Just Dance → Billie Jean | -1.8 % | Rubber Band                   | Signalsmith                           |
| Uptown Funk → Save Your Tears        | +2.6 % | Rubber Band                   | WSOLA (Signalsmith also weak)         |
| Queen → Eye of the Tiger             | -1.5 % | WSOLA (Rubber Band also good) | Signalsmith, "a hum"                  |
| Gin and Juice → Hypnotize            | -0.7 % | Rubber Band                   | Signalsmith, hum (WSOLA distorts too) |

**Rubber Band best in 6 of 8 and never worst**; the two it did not win,
the listener called it good as well. Signalsmith never best, worst five
times, with a hum of its own. Including the one pair past today's
`MAX_STRETCH` (-4.5 %), where WSOLA was worst.

Cost, 30 s stretched on one core of an i9-9900KF: WSOLA 48x realtime,
Signalsmith 15x, Rubber Band R3 10x. Only the ease and the overlap are
stretched, but a small server (a Pi) is not measured yet.

## Next

**Built (same day)**: `core/timestretch.py` is Rubber Band R3 via
`pylibrb`, WSOLA is gone. Two things only the engine-length tests showed:
setting the ratio anew every block (as that block's in/out length, which
was what listening 4 heard) drifted ~6 ms over a 40 s hold and kept going,
while setting exactly 1/rate, only when it changes, holds within ±2.3 ms;
and Rubber Band's start pad does nothing once 16384 frames of history go
in first. The sdist does not compile against nanobind 2 (pinned `<2` as a
build constraint); Linux arm64 builds it against Ubuntu's librubberband
3.3.0, the Docker image against Alpine's 4.0.0, both R3 - checked in
stock containers on amd64 only. pylibrb releases the GIL while it works,
should the stretch ever need to leave the event loop on small hardware.

1. **`MAX_STRETCH` back up?** -4.5 % was Rubber Band's clearest win; a
   round of pairs at 4-6 % decides how far.
2. **The outgoing song's last sung line**, the other half of the lyrics:
   not starting the overlap while the old song is still mid-verse.

Ask the listener "A or B, which is better", blind; a diagnosis in
technical terms is not what they can give, and not needed.
