# Which photo edges to continue - CLOSED 2026-09-27, question dropped

A detail page shows a Fanart.tv background at the right and continues its
left edge across the rest of the band. Until 2026-09-27 it first judged
whether the edge was calm enough to continue (`edgeIsSmooth()`, removed)
and faded the photo out if not; its thresholds were tuned by hand against
whichever photo had last looked wrong. This entry is the measurement series
that replaced the hand-tuning - and the finding that ended the judging
altogether: **once the continuation settles into one colour away from the
photo, every edge can be continued.** The rules, the labelled fixture and
the fit script are gone; `scripts/edge-fill/` remains, to look at a change
across all cached photos at once.

## Outcome

- The continued edge carries its own bands for 15% of the photo's width,
  then eases into a single colour. A streak only shows next to the picture
  it came from, where it reads as part of it.
- That colour is the photo's **background** where its border has one (the
  same detection the banners use), else the edge's **main** colour. An
  average was tried first and made grey mud of a blue backdrop with white
  lettering at the edge; the edge's own main colour then picked a black
  sleeve over a white studio backdrop. The bands next to the photo are
  drawn from background pixels too, so a sleeve or sign at the edge is left
  out of them.
- The maintainer went through the samples labelled "fade" in the new
  rendering and found them all continuable; the judging was removed.
- Only a photo whose pixels can't be read still fades out.

## What was measured

All 590 cached backgrounds, each in both framings (the artist page's 16:9,
the album page's 2.4:1 band): 1180 samples, taken by
`scripts/edge-fill/sample.mjs`.

**Headless Chromium is not the app.** The same page, the same JPEG and the
same `drawImage` gave different 64x16 samples in headless Chromium
(Playwright) and in Electron: 12 of 590 photos were judged differently per
framing. The first report (a group photo on white, continued on the album
page but not the artist page) only reproduced in Electron. Sampling is done
in Electron since. A high-quality downscale is no way out: in headless
Chromium `imageSmoothingQuality = 'high'` changed nothing, and in Electron
`createImageBitmap(..., { resizeQuality: 'high' })` judged 19 photos
differently from the app's own `drawImage`.

## Strip width (2026-09-27)

The smoothness check read 6 of 64 columns (~9%), twice what is actually
continued (3). A shoulder in column 6 of an otherwise pure-white edge failed
the "dark band between light ones" rule. Over all samples, in Electron:

| Columns | Artist page: newly continued   | no longer continued   |
| ------- | ------------------------------ | --------------------- |
| 5       | 14, nearly all plain backdrops | 7, 5 of them streaky  |
| 4       | 29, ~8 of them streaky         | 12, half of them fine |

Narrower than 5, each band averages too few pixels and noise passes the
step and turn rules. Judging the steps over the continued 3 columns only,
while keeping the 5-column evenness check, did worse than either (gained
16-18, lost 11-17).

## Studio backdrops (2026-09-27)

A grey paper backdrop with a hat and jacket from the fourth column on
failed at any width that includes them, though the 3 continued columns are
a clean gradient. A second check over just those columns, far stricter
(brightness 12, colour 8, steps 32), continues 9 more photos per framing and
drops none. Loosening it: steps of 38 let the first streaky edge in, a
band stray of 18 the next.

## Labels and the fit

Every sample was pre-labelled by eye (Claude, from rendered previews):
continue / fade / unsure. The 241 samples (143 photos) that disagreed with
the rules or were unsure were then labelled by the maintainer on
`review.py`'s page; the other 939 kept Claude's label, which the rules
already agreed with.

The review moved a lot: of the samples Claude had marked "fade", 40 of 53
became "continue"; of the "unsure", 67 of 112 did. The maintainer tolerates a
continued edge far more often than the rules or Claude did.

**Consistency.** The maintainer felt inconsistent while labelling. Measured:
the two framings of the same photo got the same label in 95 of 98 photos,
and of 37 samples with a near-identical edge elsewhere (RMS < 12 over the
continued columns), 33 got the same label. What varies is the borderline
case, where either verdict looks acceptable - noise there costs nothing.

**The fit (2026-09-27, reviewed labels, before the single-colour fill).** Today's rules: 28 streaking edges
continued, 87 continuable edges faded. Fitted on all samples, the best
thresholds reach 18 / 86 (streak cost 2) or 28 / 72 (cost 1), but fitted on
half the photos and scored on the other half they do no better than today's
rules (cost 71 -> 74, and 55 -> 52). **No threshold change was taken.** The
rules as they are sit at what thresholds on these features can do; the 87
missed continuations need a distinction the rules do not make, or a fill
that makes the question matter less - which is what settled it (Outcome,
above).

## Ruled out

- **Person segmentation at the edge** (MediaPipe selfie segmenter,
  `personAtEdge.ts`, added and removed 2026-09-26). It answers "is a person
  at the edge", while the question is "does the continuation streak" -
  lights, sofas and patterns streak without anyone in them.
- **Headless Chromium for sampling**, see above.
- **Tuning the thresholds against labels**, see the fit: at their limit.
- **An average colour for the continuation**: mixes lettering, sleeves and
  backdrop into a colour that is nowhere in the photo.
