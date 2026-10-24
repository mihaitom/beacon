# Waveform computation blocked the event loop (RESOLVED 2026-08-22)

**Symptom:** 2.53s during which nothing at all was serviced, including the
casting device's open `/stream` socket. Triggered by an 80-minute mix
(52.8M samples).

**Cause:** `_compute_peaks()` used `max()`/`min()` over `array.array` slices.
Those look like bulk C operations but iterate via the iterator protocol,
boxing **every sample** into a Python int. Worse, the caller's
`asyncio.to_thread()` gave no protection at all: boxing ints holds the GIL for
the entire duration, so the "background" thread stalls the loop just as
thoroughly as inline code would.

The docstring explicitly claimed the opposite ("C-speed", "run via
asyncio.to_thread() out of caution"), which is why it survived review.

**Fix:** vectorized with numpy. Verified byte-identical output across eight
edge cases (empty input, odd byte count, fewer samples than buckets, the int16
minimum, an uneven remainder, silence) and **178x faster**; extrapolated, that
turns 2.12s into 0.012s for the mix above.

**Why tests missed it:** the output was always correct. Only the runtime was
the bug. `tests/test_waveform.py` now carries a guard that times
`_compute_peaks` against a boxed pass over the same data, so the threshold
adapts to the machine instead of being a flaky wall-clock bound.

**Lesson:** `asyncio.to_thread()` only helps for work that releases the GIL.
Moving GIL-bound CPU work onto a thread changes nothing.
