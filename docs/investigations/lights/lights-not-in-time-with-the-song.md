# FIXED: The lights are not in time with the song

2026-11-01, on `feature/hue-lights` (never released). Some songs got only a
slow pulse with the loudness, the colours of the rotation stood still, or
the flashes came between the beats instead of on them.

## What was seen

- "Freaky 1" (tech house, 129 BPM): a slightly pulsing red, nothing on the
  beat.
- "Put Your Hands Up for Detroit" (radio edit, 128 BPM), party style with
  rotation: the colours did not turn, nothing in time.

Not the dev session reloading: connect runs without reload.

## Cause

The lights took the beatmix grid (`core/beat_analysis.py`) and turned
everything below `MIN_CONFIDENCE` down - the song then has no beats, so no
flashes, and the rotation, which turns with the heard beats, stands still.
That grid is built to refuse a doubtful song, which is right for a beatmix
and wrong for the lights.

Measured on 120 songs drawn at random from the library (seed 7), against
their BPM tags (every one had one; double or half counts as right):

|                                        | grid     | lights' own beats (`lights/beats.py`) |
| -------------------------------------- | -------- | ------------------------------------- |
| tempo right                            | 117      | 120                                   |
| songs with beats                       | 90       | 119                                   |
| beats on the kick, not half a beat off | 74 of 90 | 119 of 119                            |

Three separate faults, all in the one grid:

1. **Turned down for a wandering tempo.** Played songs ("Come On Eileen",
   "Brown Sugar", "Beast of Burden", "Ladies' Night", "Azzurro") fail the
   check that both halves of the song put the beat in the same place, and
   so does a track whose sections lean on different parts: in Detroit the
   kick leads in one section and a syncopated riff a sixteenth earlier in
   the next, alternating, not drifting.
2. **Half a beat off.** The phase comes from the full band, where a
   house track's offbeat hi-hats are the strongest onsets. 16 of the 90
   songs the grid did take sat on the hi-hats - the flashes between the
   beats.
3. **A tempo 4/3 off** ("Alone, Pt. II" at 117 instead of 88): only kept
   out by the halves check, by luck.

## Fix

`lights/beats.py`, separate from beatmixing: the grid's tempo, corrected to
4/3 or 3/4 where that folds at least 15 % sharper (every margin from 10 to
20 % got all 120 tempos right), then every beat placed on its own by
dynamic programming over an envelope that is 60 % kick - the best chain of
onsets about a beat apart. A song the grid is unsure of still gets beats
where its onsets repeat a beat or two later (median over 8 s stretches,
0.15 or more). The one song left out is a ballad without drums ("Hijo de la
Luna", 0.14).

Why the suite did not catch it: the lights' tests used click tracks with
nothing between the beats and a constant tempo, which the grid always gets
right. `tests/test_light_beats.py` now has louder hats between the kicks
and a drummer from 116 to 124 BPM.

## Ruled out

- **Letting the kick decide the halves check** (5885b7c, kept for
  beatmixing): fixed "Freaky 1", not Detroit, where the kick itself moves
  between the sections.
- **"The song's beat is still there in each half"** instead of "both halves
  agree": every song passes it, the 4/3-off "Alone, Pt. II" too.
- **Beats against the gaps between them** as the test for a beat: house
  has its hi-hats in the gaps and scored lowest; ballads scored highest,
  since the tracker puts a beat on every chord.
- **The fold's sharpness** as the test for a beat: it assumes one tempo, so
  played songs with drums scored like ballads.
- **Repetition one beat later only**: a half-time groove measured 0.12 at
  one beat and 0.46 at two.

## Open

The beatmix grid has fault 2 as well. Two songs mixed with one grid on the
kick and the other on the hi-hats would line up half a beat apart; not
looked at for beatmixing.
