# AirPlay reports nothing when it dies mid-track (OPEN)

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

Related, and visible from the same code: AirPlay holds each track entirely in
RAM (`http.get()` on `/stream` into a `BytesIO`). For an 80-minute mix that
is over 100MB per target. It is a deliberate workaround for pyatv's
hardcoded 10s decoder-detection timeout - see the comment in `airplay.py` -
but an expensive one for long tracks.
