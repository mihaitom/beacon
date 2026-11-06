# FIXED: The lights switch between the kick and the bass

2026-11-06, on `development` (never released). The lights reacted to the bass
in some stretches of a song and to the kick in others.

## How it was measured

Against what is really played rather than against another guess: 88 songs (40
drawn at random from the library, the rest bass-heavy picks and the songs of
the earlier case) were split into stems with Demucs, as a measuring tool only.
Kicks are the jumps below 150 Hz in the drum stem, other drum hits the jumps
from 300 Hz up in it, bass notes the jumps in the bass stem. The code under
test only ever saw the mix.

The first version of that reference found 15 kicks a minute in a house track at
127 BPM: a sub kick can take 80 ms to its top, and the test wanted a jump
within 50. Anything that says "the kick" here needs checking against a picture
of the stems first (kick and bass energy by position in the beat, per section).

## Cause

Three faults, all of them visible as "sometimes this, sometimes that":

1. **The chain moved onto the bass.** The kick envelope is spectral flux on a
   log spectrum below 150 Hz, where a quiet bass note rises about as far as a
   loud kick. "Put Your Hands Up for Detroit" had 49 % of its beats about 100 ms
   ahead of the kick, section by section, exactly on the bass riff. The same
   happened in "Adagio for TRON" (Teddybears remix); "Nuh Ready Nuh Ready" went
   about 100 ms late.
2. **Every beat flashed.** While bass played a beat got at least 0.6, and the
   full-band onset counts a vocal or a pad as much as a drum. A beat with
   nothing at all on it flashed at 0.63 on average, one with only a bass note at
   0.86, one with a kick at 0.93. So the flash could not tell them apart.
3. **Half the tempo.** Four songs ran at 60-68 BPM with a kick twice per beat,
   so the lights took every other kick.

## Fix

- **Beats follow the level.** Of everything measured on the mix, the plain level
  in the bass band told kick from bass note best (AUC 0.95, median per song over
  the first 8 songs; pitch sweep 0.89, how fast it decays about 0.75). `punch_envelope`: how far the level
  below 150 Hz jumps. The chain is 70 % that, 30 % the old envelope.
- **A flash is as strong as its drum.** `beat_hits`: the kick against the
  song's strong beats, or a snare or clap up to 0.6. The bass floor is gone: its
  reason was a busy bassline burying the kick's onset, which the level does not
  do.
- **Half tempo is doubled** where as much punch falls between the beats as on
  them (four songs at 0.74-0.98, the next slow one 0.56), up to 160 BPM.

| 87 songs with beats, means                | before | after |
| ----------------------------------------- | ------ | ----- |
| flashes on a kick                         | 53 %   | 76 %  |
| flashes on nothing at all                 | 25 %   | 8 %   |
| beats near a kick that are on it          | 92 %   | 95 %  |
| sections with a kick the beats sit beside | 29 %   | 20 %  |
| flash strength on a kick                  | 0.93   | 0.94  |
| flash strength on another drum            | 0.89   | 0.43  |
| flash strength on a bass note only        | 0.86   | 0.48  |
| flash strength on nothing                 | 0.63   | 0.14  |

"Detroit" went from 48 % to 96 % of its beats on the kick. Sections beside the
kick improved in 24 songs and got worse in 4. About 30 % fewer beats now count
as heard, which is the point, but also what a rock song will show most.

Why the suite did not catch it: its songs had kicks and hats but no bass. One
test even pinned the bass floor as wanted behaviour.

## Worse than before

Six songs lose on at least one measure, mostly where the kick is quiet against
the bass or the recording old: "Zou het erg zijn lieve opa" (beats on the kick
82 % to 69 %), "Mary in the Morning" (64 % to 58 %), "Happy Together" (84 % to
75 %), "Nuh Ready Nuh Ready" (80 % to 71 %, though its flashes on a kick went
from 39 % to 74 %), "Stepdad" (98 % to 92 %) and "Do You Speak English"
(only fewer kicks flash, 84 % to 74 %).

## Ruled out

- **A tighter chain** (`_TIGHTNESS` 300 instead of 100): no better than the
  envelope change alone, and worse on the old envelope (on 14 songs). The tempo was never the
  problem.
- **The punch alone in the chain:** "Zou het erg zijn" fell to 35 %, "Stepdad" to
  80 %, since nothing holds the chain where the kick is not the loudest. 50 %
  punch let the bassline back in ("Detroit" 88 %), 70 % keeps both.
- **Looking for a snare or clap up to 25 ms either side of the beat:** needed
  while the chain ran on the punch alone, no gain since (flashes on nothing 8.6 %
  with it, 7.7 % without).
- **Doubling on the kicks between the beats alone:** songs at 105-125 BPM with
  kicks on the eighths measure 0.7-0.98 too and are at the right tempo. Only the
  200 BPM limit kept them out, and "Broken" at 96 BPM sat right on the edge.
- **Attack and decay as features:** far weaker than the level
  (see the AUC above); not worth the code.

## Open

- **Kicks off the beat get no flash of their own.** Hip-hop plays them
  syncopated: "Candy Shop" flashes on 62 % of its kicks, "Just a Lil Bit" on 50 %.
  That would take flashes on kicks instead of on beats, which changes the look.
- **Not judged by eye yet.** All of this is measured; the lamps have not been
  looked at. The lead may want another look: beats land about 8 ms earlier than
  before.
- `core/beat_analysis.py`'s own grid keeps its log-spectrum kick. Beatmixing was
  not looked at.
