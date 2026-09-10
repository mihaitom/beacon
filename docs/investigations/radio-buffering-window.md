# The buffering bar outlasts the sound (relayed Sonos)

**PARTLY FIXED 2026-09-10.** The reference point is now measured instead of
assumed. The window's length is still a guess, and the tool to measure it is
in the repo but has not been pointed at a real speaker yet.

## Symptom

Casting a station to a Sonos: audio is already coming out of the speaker
while the seek bar still shows the indeterminate "buffering" bar instead of
the "Live · {elapsed}" readout.

## Where the number comes from

A relayed Sonos has no position to poll — `first_radio_position_delivery()`
excludes it, because over `x-rincon-mp3radio://` it reports a flat 0.00s. So
`radio_is_buffering()` cannot watch for the device starting and estimates
instead: it holds the bar up for `ASSUMED_DEVICE_LEAD_SECONDS` (4.7s) after
the station starts.

Two separate things were wrong with that.

## 1. The reference point was late (fixed)

`radio_is_buffering()` counted from `st.clock.start()`. In `/play-url` that
line runs *after* `await target.play(...)` has returned, and the device opens
its own connection to the relay inside that call. So the window started
after the device had already been buffering for the tail of the dispatch,
and the bar stayed up for that long on top of the device's real buffer.

Fixed by recording when the device actually connects
(`SessionState.radio_device_connected_at`, set in `radio_stream()`) and
measuring from that. Earliest connection per dispatch wins — a Sonos opens
several connections per cast, and letting a later one re-arm it would push
the window out every time.

This only holds up if the relay feeds a late-joining subscriber at exactly
1x, which is the measurement below.

### Measurement: what a device gets after it connects (2026-09-10)

`RadioRelay` driven standalone against a local station paced with `-re`,
subscribed to the way the cast path does (`burst=False`) after a delay
standing in for the dispatch. Delivered audio seconds against wall clock:

| Device connects | Wall 5s | Delivered | Lead |
| --------------- | ------- | --------- | ------ |
| +0.0s           | 5.04s   | 4.13s     | -0.91s |
| +0.5s           | 5.04s   | 4.57s     | -0.47s |
| +1.0s           | 5.06s   | 5.12s     | +0.06s |
| +2.0s           | 5.08s   | 5.12s     | +0.04s |
| +4.0s           | 5.03s   | 5.07s     | +0.03s |

Strictly 1x once the relay is up. The lead at 0.0s/0.5s is the relay's own
startup still in progress, not a rate.

**Ruled out by this:** the theory that ffmpeg's `-readrate_initial_burst`
reaches the device and lets it start early. It does not — the burst is
already spent by the time the device connects, and what it produced sits in
the relay's `_burst` deque, which the cast path deliberately does not hand
out (only `/stream/radio-local` asks for it).

Script: `scratchpad/measure_relay_delivery.py` in the session it was written
in; ~120 lines, easy to rebuild from this table if it is gone.

## 2. The window's length is an upper bound used as a reading (open)

`ASSUMED_DEVICE_LEAD_SECONDS = 4.7` was measured via the ICY echo, and
`routes/upnp.py` says what that method actually yields: an echo means "the
device is currently reporting this title", not "it started playing it just
now". That is an upper bound. Used as an exact value it holds the bar up
longer than the speaker is silent, which is the remaining symptom.

It is also a number measured for a different question (how far the analyzer's
clock has to lag to match what is audible), not for this one (how long until
the speaker starts).

### How to measure it properly

There is no device-side signal, so measure from the outside: hand the device
far more audio than it can take at once and watch where it stops accepting.
Armed with `BEACON_RADIO_BUFFER_PROBE=1`, which

- raises the relay's rolling cushion to 120s / 8MB (`_burst_limits()`), and
- gives the cast connection that cushion up front and times how much the
  receiver swallows before a single socket write first blocks for more than
  0.25s (`_log_buffer_probe()`).

One log line per connection: `[probe] for <session>: absorbed 6.40s of audio
in 0.31s before pushing back`.

**The reading includes this machine's socket send buffer**, which on the dev
box autotunes to 4MB (`/proc/sys/net/ipv4/tcp_wmem` is `4096 16384
4194304`). That is the same order of magnitude as the thing being measured,
so the raw number is not the speaker's buffer. Take a reference run against a
client that reads nothing (`curl --limit-rate 1 <relay url>`) to measure the
send buffer alone; the difference is the device's own.

The probe is why the cushion constants became `_burst_limits()` rather than
staying literals. Off by default, so nothing about ordinary casting changes.

## Not covered here

The visualizer's own use of the same constant is out of scope — see
`radio-visualizer-cast-sync.md`.
