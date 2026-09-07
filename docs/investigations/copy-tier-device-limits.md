# The copy tier never checks what the device can actually play (RESOLVED 2026-08-24)

Root-caused 2026-08-22, fixed 2026-08-24.

**Symptom:** a 24-bit/96 kHz FLAC stopped playback 1.1s after it started.

**Cause:** `resolve_output_format()` picked the stream-copy tier purely on the
source *codec*. Sample rate and bit depth were never looked at, so a FLAC was
handed to the renderer untouched whatever its format. Sonos supports FLAC only
up to 24-bit/48 kHz, and said so itself through UPnP eventing:

    ERROR_UNSUPPORTED_FREQ: 9,0,Bad,<host:port>,<stream url>,96000,0

**The obvious fix would not have worked.** Falling back to the
lossless-reencode tier alone keeps the sample rate, because its arguments are
`["-acodec", "flac", "-f", "flac"]` with no `-ar`. Re-encoding 96 kHz FLAC to
FLAC yields 96 kHz FLAC and the device rejects it again. A real resample is
needed.

**Limits are per device class**, so this wanted declared capabilities rather
than one hardcoded cap: Sonos tops out at 24/48, Chromecast handled 24/96,
AirPlay is typically 16/44.1, DLNA varies per renderer (a conservative
24/48 was assumed here, borrowed from Sonos).

**Not related to the drops in [the symptom file](mid-track-drop-symptom.md)**,
and worth keeping separate: this produces an explicit device-reported error,
while every mid-track drop reported `TransportStatus` unchanged. It is also
how that distinction was established at all - the first non-`OK` transport
status ever seen in this investigation.

## The fix

- `delivery/base.py`: `BaseDelivery` gained `MAX_SAMPLE_RATE_HZ: int | None`
  and `MAX_BIT_DEPTH: int | None`, both `None` by default (no known limit,
  unchanged behaviour for anything that doesn't declare one).
- Per-class limits: `SonosDelivery` 48000 Hz / 24 bit; `ChromecastDelivery`
  96000 Hz / 24 bit; `DlnaDelivery` 48000 Hz / 24 bit (the conservative
  Sonos-borrowed assumption, since DLNA varies per renderer);
  `AirPlayDelivery` 44100 Hz / 16 bit (lower priority to verify live -
  AirPlay is a secondary target for this project).
- `core/state.py`: new `audio_capability_limits(delivery)` returns the most
  *restrictive* `(max_sample_rate_hz, max_bit_depth)` across every delivery
  currently active - the min across a `DeliveryManager`'s members, so a
  multi-target cast is bounded by whichever device is least capable.
- `core/streamer.py`: `_probe_source()` now returns a `SourceInfo(codec,
  sample_rate, bit_depth)` instead of a bare codec string, parsed from the
  same ffmpeg stderr line (bounded to that line only, so an embedded-cover
  video stream can't contaminate the audio stream's own sample rate/bit
  depth). `resolve_output_format()` gained `max_sample_rate`/`max_bit_depth`
  parameters: a source that would have qualified for stream-copy but exceeds
  either limit is routed to a resampled-FLAC tier instead
  (`-acodec flac -f flac`, plus `-ar <limit>` and/or `-sample_fmt s16` only
  for whichever of the two actually needs correcting) - never upsampled, only
  ever capped down. The existing lossless-reencode tier gained the same
  resample args when needed.
- `routes/playback.py`'s `/play` handler and `routes/stream.py`'s
  `_dispatch_queued_track()` both call `audio_capability_limits(target)` and
  pass the result into `resolve_output_format()`.

**Why the test suite didn't catch it originally:** `resolve_output_format()`
had no concept of a device limit to violate - the tier selection was correct
for the information it had, which was incomplete by design, not by omission.
The new tests (`tests/test_streamer.py`, `tests/test_state.py`) cover: a
source within the limit still uses copy, a source over either limit gets
resampled (rate only, bit depth only, both), a source is never upsampled
toward a *higher* limit, an undetected sample rate is left alone rather than
guessed at, `None` limits (no caller declared any) leave high-res sources
untouched, the resample tier ignores ReplayGain the same way the plain
lossless-reencode tier already does, and `audio_capability_limits()` itself
across a single delivery, a `DeliveryManager` with mixed limits, `None`, and
deliveries with no declared limit at all.
