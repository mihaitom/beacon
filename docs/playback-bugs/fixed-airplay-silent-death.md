# AirPlay reports nothing when it dies mid-track (FIXED 2026-08-26)

Found 2026-08-22 while checking which cast targets the interruption handling
(see [Cast device drops mid-track - symptom](mid-track-drop-symptom.md),
"What Beacon does about it") covers.

Whether a target benefits from any of this depends on **who fetches the
bytes**:

| target | model | covered |
|---|---|---|
| Sonos | pulls `/stream` for the track's duration | yes |
| DLNA | same, via UPnP AVTransport | yes |
| Chromecast | receiver fetches the URL itself | yes |
| AirPlay | downloads the whole track into memory, then plays from the buffer | **no** |

The first three share one code path, so the interruption handling reached
them for free - it lives in `stream_with_completion`, not in anything
Sonos-specific.

AirPlay does not. Its `/stream` connection is opened for the download and
closed *normally* when that finishes, so there is no cancellation to detect,
and playback then runs with no connection open at all. A device dying
mid-track surfaces only here:

    logger.warning(f"[AirPlay:{self.target}] Device disconnected during stream")

A warning and nothing else: no `is_streaming = False`, no broadcast, no
notification. Exactly the silent death this whole investigation started
from.

**Polling it is not an option, and that is not an oversight.** AirPlay here
uses pyatv's `stream_file`, which pushes raw audio to what is effectively a
dumb sink - there is no transport session to query, so there is no position
to read. `get_position()` was tried and does not work; `SUPPORTS_POSITION`
being absent (so `False` from the base class) reflects the protocol, not
neglect. The position-resync loop therefore never runs for an AirPlay target
either, which is why the other targets' second safety net is missing too.

**But the failure is still observable, from the sending side.** Beacon is the
sender, and a send to a device that has gone away fails - which is exactly
what the handler above already catches and discards into a log line. So a fix
needs no new channel to the device, only a way back into the session:
`AirplayDelivery` holds no reference to it, so raising the same `interrupted`
broadcast needs a callback or an explicit session handle passed in at
construction.

Worth noting for whoever builds it: this signal is *less* ambiguous than the
one the pull-based targets give. A clean FIN cannot be told apart from
somebody pressing stop, which is why Beacon refuses to auto-resume there. A
failed push is a genuine error.

## The fix (2026-08-26)

`BaseDelivery` gained an `on_playback_error` callback, attached in
`core/state.py`'s `resolve_target()` - a callback rather than a session
reference because `core/state.py` imports `delivery`, and the reverse would
be circular. The handler above now calls it instead of only logging.

What it reports through is `mark_interrupted()`, pulled out of
`_mark_disconnected_if_not_reconnected()` into `core/session.py` so both
paths raise the identical interruption: same frozen clock, same
`interrupted=True` broadcast, same toast. No grace period on this path, per
the paragraph above - a failed push needs no waiting to see whether a
reconnect turns up.

**Why the test suite never caught it:** there was no test that made an
AirPlay device fail. Every existing `AirPlayDelivery` test drove the happy
path or an explicit `stop()`; the `except` branch that logged the
disconnect had no coverage at all, so nothing ever asked what it did
*besides* log.

**Still not per-device.** The callback marks the whole session interrupted.
For a single-target AirPlay cast those are the same thing; for a
multi-target one they are not - see
[One device dropping out of a multi-target cast is never surfaced](multi-target-partial-drop-not-surfaced.md),
which is the same missing per-device notion of "streaming" and stays open.

## The RAM half, fixed with it

AirPlay used to hold each track entirely in RAM (`http.get()` on `/stream`
into a `BytesIO`) - over 100MB per target for an 80-minute mix. That was a
deliberate workaround for a hardcoded 10s timeout in pyatv, and the
workaround turned out to be unnecessary: the timeout lives in
`PatchedIceCastClient.read()`, which only serves the path pyatv takes for a
*URL string*. `open_source()` sends anything that is neither a string nor an
`io.BufferedIOBase` to `StreamReaderWrapper`, which just awaits
`source.read(n)` with no timeout anywhere.

`_ResponseReader` (in `airplay.py`) is that one method over an open httpx
response. Back-pressure is inherent - the next chunk is pulled only when
pyatv asks - so nothing accumulates. An `asyncio.StreamReader` fed by a pump
task would have brought the same problem back in a new shape, since
`feed_data()` has no flow control without a transport behind it.

**Measured, not argued** (2026-08-26), because the claim being overturned had
stood unchallenged in a code comment since the first commit. Feeding a
`_ResponseReader` straight into pyatv's own `open_source()` - real pyatv,
real miniaudio, no mocks - and decoding 300 frame batches:

    source type: BufferedIOBaseSource
    decoded 300 frame batches, 316800 bytes of PCM
    chunks pulled from the response: 27 of 2512

1% of the file touched for the first few seconds of audio. That is both
halves of the claim at once: pyatv really does decode incrementally from
this, and it really does stop pulling once it has enough.

What this does **not** cover is the RTP push to an actual device. The
decode chain is proven; the wire to a real speaker is not, for want of one
to test against.
