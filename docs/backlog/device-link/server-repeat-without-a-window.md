# Repeat on a server only works while a window is open (without transitions)

**Status:** open since 2026-11-11, known when the server player was built,
deliberately left out. Not seen on a device.

The v1 `repeat` command on a server (`connect/routes/player_server.py`) only
sets `session.state.repeat_mode` through `/queue`. What happens at the end of
the queue then depends on the path:

- **With transitions on** it already works: `next_item()` in
  `connect/routes/mix_cast.py` repeats the song for `one` and wraps to the
  start for `all`.
- **Without transitions** `_advance_or_end()` in `connect/routes/stream.py`
  knows nothing of repeat. Its docstring says so: wraparound and replay "still
  need the renderer awake". With no window open, a cast started or steered
  from an app (Home Assistant on a server) simply ends after the last song,
  whatever repeat says.

## To do

Teach `_advance_or_end()` what `next_item()` already does: `one` dispatches
the current track again, `all` wraps `next_index` to 0 when the queue is
exhausted (before the autoplay top-up, which `_maybe_autoplay_topup()`
already skips when repeat is on, see `stream.py:176`).

Two things to settle first:

- **An open window.** It acts on repeat itself after the "track ended"
  status. Once connect advances by itself, the window must not repeat a
  second time. Check how the window reacts today to a server-side
  auto-advance it did not ask for (it adopts it via `reconcileFromStatus()`
  for an ordinary next song) and whether that holds for index 0 and for the
  same song again.
- **Check while there:** whether `repeat one` with a window open is overridden
  today by the server's own auto-advance to the next song. Read from the code
  it could be, but it was not tried.

It touches the auto-advance hot path, so it needs a run on every speaker type
before it ships (a replay of the same track is a new dispatch of the same
URL, which some renderers treat as "already playing").
