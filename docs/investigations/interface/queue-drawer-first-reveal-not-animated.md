# OPEN: the queue drawer's first-ever reveal does not animate

The first time the queue drawer opens in a session, its rows are supposed to
slide in one after another like they do every other time. They do not, and
`appear` on the `<transition-group>` in `QueueDrawer.vue` has been off since
2026-08-26 for that reason: with it on, rows start at their final place and
are then dragged far off to the side, crawling back over a half-second.

Tried again on 2026-09-07 and reverted the same day. **The behaviour in the
app was unchanged by the attempt** - what follows is what was measured, what
the measurement was mistaken for, and what is left to try. The shipped
behaviour is still the workaround: rows render at their final position, no
entrance for that one case.

## The known root cause, unchanged

Vue's `applyTranslation()` in `@vue/runtime-dom` has no guard against an
element that is still mid-enter when the list re-renders: `.queue-move-move`
lands on top of `.queue-move-enter-*` and the two fight over `transform`.
Unfixed as of the current beta. Everything below is about *what triggers a
second render* in this component, since that is the half we can influence.

## What was measured on 2026-09-07

Real browser (`pnpm test:layout`), first-ever open, `appear` on:

- **The second render is still there and still datable.** ~110ms after the
  mount, cancelling the row's transform transition (`transitioncancel` at
  110ms, restart at 213ms, end at 513ms). Not traced any further; consistent
  with the earlier finding that it lives inside `TransitionGroup`'s own
  instance.
- **A real, separate artifact exists when rows enter while the drawer is
  still moving.** The rows live inside the drawer, so `TransitionGroup`'s
  FLIP pass measures the drawer's own travel as a move worth animating: a row
  starting its entrance 50px out was dragged to **385px** out and eased back
  from there. Suppressing `.queue-move-move` for the length of the slide
  removed that reliably in the harness.
- **That was not the reported bug.** With the suppression in place and
  `appear` back on, the harness looked clean across ten first-ever opens (60
  rows, both drawer modes) - and the app still showed the original
  behaviour. The 385px drag is a genuine second problem that the harness
  reproduces; it is not what the user sees.

The lesson worth keeping: this harness (a `VApp` with `VMain` and the drawer,
or even the real `DefaultLayout` mounted in a browser test) does **not**
reproduce the reported bug. Anything measured in it about this case is
evidence about the harness until it is confirmed in the running app.

## Also ruled out

- **`scrollToCurrent()`** on open, the obvious suspect since it moves every
  row. Measured with a queue deep enough to actually scroll: entrance clean,
  stagger intact.
- **`temporary` vs `permanent`** on the drawer (the layout change made the
  same day): five first-ever opens each, identical results.
- **The reveal stagger.** Moving it off the inline `transition-delay` and
  onto `--queue-reveal-delay` (2026-09-06) was a real fix for one of two
  overlapping causes, but does not make `appear` safe on its own.
- **Vue's version.** 3.5.41 -> 3.5.42 on 2026-09-06 is a patch release, and
  the missing guard is absent from the current beta too.

## Two dead ends worth not repeating

- **Nothing tells a child when its parent has finished animating.** A drawer
  that is mounted and opened in the same breath is put in place with its
  transitions suppressed and fires **no transition events at all**, while
  still changing position by its full width between two frames. Waiting for
  `transitionend` therefore does nothing in exactly the case that matters.
- **`requestAnimationFrame` does not run in the browser test environment.**
  Watching the drawer's position frame by frame would be the honest way to
  know when it has arrived; the loop never ran once under headless Chromium.
  CSS transitions themselves do run and are measurable - only the frame
  callbacks are missing. Any timing mechanism built on rAF is untestable
  here.

## What is left to try

Reproduce it in the running app first, with the sampling recipe below, and
only then change anything - the two attempts so far both started from a
harness that was already clean.

Sampling recipe (this is what produced the numbers above): attach
`transitionstart`/`transitionend`/`transitioncancel` listeners to
`[data-queue-index="0"]`, sample `getComputedStyle(row).transform`, its
class list and the drawer's `getBoundingClientRect().left` every 25ms, and
print the log at the end. In a browser test the log has to be thrown
(`throw new Error(...)`) - `console.log` from the browser context does not
appear in `pnpm test:layout`'s terminal output.
