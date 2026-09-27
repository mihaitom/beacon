# Edge-fill review

A detail page continues its Fanart.tv photo's left edge across the rest of
the band (`leftEdgeFillFromPixels()` in `src/renderer/src/services/edgeFill.ts`).
These two scripts show that continuation for every cached background at
once, so a change to it can be judged across all the photos rather than on
the one that looked wrong last.

| File         | What it does                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sample.mjs` | Samples every cached Fanart.tv background through the app's own `edgeFill.ts`, inside Electron, in both page framings. Writes `.cache/samples.json`        |
| `review.py`  | Local page with each continuation drawn as the detail page draws it. Tiles can be labelled continue / fade / unsure as notes, kept in `.cache/labels.json` |

```bash
pnpm exec electron scripts/edge-fill/sample.mjs   # after changing edgeFill.ts, or new photos
python3 scripts/edge-fill/review.py               # http://localhost:9199
```

`review.html` repeats the page's fill styles from `DetailPageBackdrop.vue`;
change both together.

Sampling runs in Electron on purpose: Chromium downscales a canvas
differently from one build or GPU to the next, and headless Chromium judged
a dozen of the photos differently from the app. See
`docs/investigations/edge-fill-thresholds.md` for how the continuation got
to where it is.
