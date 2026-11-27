# REFERENCE: How deep the Fractal Zoom can go, and what holds it there

2026-11-23. Measured while adding the period-964 to period-2445 minibrots
(Coral Crown, Trefoil Lantern, Ivory Filigree, Woven Trinity) and the step
skipping (`services/milkdrop/bla.ts`). Nothing here is open; it is the
record of where the limits are and which fixes for them did not work.

**Decision: the four were taken out again**, the step skipping kept. They
cost 3-20 times the old scenes' iterations from the first doubling on (see
the table below), and the picture went down to 41 % of its pixels on the
development machine - visibly coarse, Woven Trinity included. Neither
Rust/WebAssembly (a CPU is far slower at this than the GPU already doing
it) nor a lower iteration limit helps. What would: drawing only part of
the pixels each frame and carrying the rest over from the last one, or
skipping tables that also hold after a rebase. Both are projects of their
own, not tried.

## What limits the depth

- **The float's exponent.** Every pixel's offset from the target (dc) is a
  float, and floats end at 2^-126. With a view about 2^-115 high at the
  end, the minibrot must be no smaller than about 2^-118: the shipped
  scenes end 2.5 doublings above the minibrot's size estimate
  (`1 / |beta lambda^2|`). Abyssal Seahorse (2^-127) and Clockwork Rose
  (2^-146) are out of reach for that reason alone. Going past it needs a
  float with a separate exponent (mantissa plus integer), which every
  multiplication then pays for.
- **The float's digits, over many periods.** A pixel near a period-P
  minibrot runs several periods before it escapes. Checked on the CPU
  against an exact (400 and 2000 bit) count, with the shader's loop
  copied in float32: at Coral Crown's end (2^-52.5) 9 of 24 random pixels
  escape at a different step (up to ~1000 steps off), at Ivory's end
  (2^-73) 4 of 24. Woven Trinity at 2^-94 matched on every pixel. The
  errors scatter pixel by pixel in an area that is fine grain at that
  depth anyway, so they don't show; at Ivory from about 2^-75 they turn
  into a flat patch, which is why that scene ends at 73.9.

## Ruled out

- **The step skipping as the cause.** Every picture with and without the
  table was rendered side by side on the GPU and matched; the CPU check
  without skipping shows the same errors.
- **Storing the orbit as two floats per part (high and low).** Rounding
  the orbit to float32 is a real source - with the orbit kept exact and
  the arithmetic in float64, all pixels match; with only the orbit rounded,
  they don't. But with the orbit split and the arithmetic in float32, the
  count of wrong pixels stayed the same (9/24, 4/24), only the error per
  pixel shrank. The float32 arithmetic on d is the other half of it.
- **Rebasing earlier** (when |z| < 2|d| or 4|d| instead of |d|): some
  pixels better, others worse, no pattern.

## Found on the way (fixed)

- A minibrot's own centre comes back to ~0 once a period (2^-112 to
  2^-139 for the shipped ones). The shader's rebase test `|Z + d| < |d|`
  rarely holds there, since Z + d is d, so the pixel ran to the end of the
  stored orbit and restarted with d out of step: a flat picture at
  Woven Trinity's end. The orbit now ends where it comes back below
  2^-110, and the restart adds a Z that is below d.
- `dot(d, d)` underflows once |d| is below 2^-63, so the step-skip test
  uses |x| + |y| instead. The rebase test still squares both sides; the
  CPU check with |x| + |y| there gave the same counts, so it was left.

## Straight edges across the smooth gradients (fixed)

Seen at Trefoil Lantern around 2^20: straight lines and corners across
the smooth areas, clearer in motion. Not the step skipping - switching
it off changed nothing, and at 2^20 it skips nothing anyway. The cause is
the blend with last frame (against flickering filaments): Butterchurn
keeps last frame in 8 bits, and a 70 % blend never closes a difference
under about 1.7 steps, so a slowly changing gradient gets stuck in
plateaus that the zoom drags across the picture. Measured against a run
without the blend, the smooth areas were off by 5-6 steps on average,
in bands. The blend now fades out from 2 to 6 pixels away from the
set's edge, where there is nothing to flicker; the smooth areas then
match exactly.

## Iterations per pixel (CPU, 150 random pixels, without skipping)

| Scene                  | 2^10 | 2^20 | 60 % in | end   |
| ---------------------- | ---- | ---- | ------- | ----- |
| M4,1 (period 98)       | 29   | 53   | 133     | 441   |
| Elephants (100)        | 256  | 102  | 172     | 400   |
| Seahorse (96)          | 49   | 112  | 115     | 330   |
| Coral Crown (964)      | 922  | 704  | 1306    | 3813  |
| Trefoil Lantern (1200) | 680  | 429  | 1409    | 4753  |
| Ivory Filigree (1002)  | 744  | 312  | 1129    | 4280  |
| Woven Trinity (2445)   | 718  | 417  | 2725    | 10702 |

The deep minibrots cost 3-20 times the old scenes from the start - the
structure around a period-P minibrot takes some P iterations to resolve.
A lower iteration limit does not help: from 2^20 on no pixel reaches it,
and at the end a third of the old limit turns the whole picture dark.
On the development machine the picture went down to 41 % of its pixels
at Trefoil Lantern, 2^20.

## Cost (SwiftShader, 320x180, so only the ratios mean anything)

| Scene, depth        | without skipping | with |
| ------------------- | ---------------- | ---- |
| M38,5-like, 2^79    | 297 ms           | 109  |
| Coral, 2^51         | 2478             | 1455 |
| Trefoil, 2^61       | 3079             | 1106 |
| Ivory, 2^73         | 2796             | 828  |
| Woven Trinity, 2^93 | 6761             | 1025 |

The first version searched the levels from the top and was up to three
times slower than no skipping in shallow views, where most searches fail;
climbing from level 1 and stopping at the first failure fixed that (each
level holds for no more than the one below).
