# Auto-advance onto a still-playing device drops the next track silently (RESOLVED 2026-08-26, via the test-suite leak fix)

One occurrence, 2026-08-24, prod. Distinct from
[Cast device drops mid-track](mid-track-drop-symptom.md): that one drops a
stream that had already delivered real audio; this one never starts audio at
all. Also distinct from the
[test-suite Sonos-discovery leak](mid-track-drop-test-suite-sonos-leak.md):
that entry's correlation with pytest timing was checked for this drop too and
was pure coincidence - this drop has its own, unrelated log trace below.
(Reconsidered 2026-08-26 - see "Reattributed" at the end of this file.)

**Symptom:** queue auto-advanced from "SIDEPIECE — Cry for You" to "Royal
Gigolos — California Dreamin" on room A's Sonos. No sound from the new track
ever played (confirmed by the listener). Backend reported the usual
10s-grace-period drop.

**Ruled out:** the reverse-proxy/cover-art-storm cause (see
[the reverse-proxy 403 file](mid-track-drop-reverse-proxy-403.md)). The
reverse proxy's access log and its IP-reputation middleware's log are clean
for the entire window — no 403s, no elevated request rate, ordinary
background traffic only (`device-volume` polling, one lyrics/cover-art burst
of normal size for a track change).

**What the app's own log shows**, in order:

    20:31:09  [position-resync] device=176.00s wall=176.42s ...       (still finishing the old track)
    20:31:09  [upnp] room A state=PLAYING uri=.../stream/e3384330   (old track, same session URL)
    20:31:09  [delivery] Sonos:room A transport state before dispatch: PLAYING
    20:31:09  [delivery] Sonos:room A → play: .../stream/e3384330  (same URL — SonosDelivery.play() calls device.stop() first, since state=PLAYING)
    20:31:09  [stream] Auto-advanced to Royal Gigolos — California Dreamin
    20:31:10  [upnp] room A state=PLAYING uri=.../stream/e3384330
    20:31:10  [streamer] [ffmpeg] Stream cancelled (Track 1)              (old track's ffmpeg torn down)
    20:31:10  [upnp] room A state=STOPPED uri=.../stream/e3384330  (device stops itself, same second)
    20:31:17  [position-resync] device=0.00s wall=8.08s ... offset -0.70s -> -8.08s
    20:31:20  ERROR [stream] Cast device dropped its connection ... | position=0.0s delivered=622802B over wall=0.5s

`stream_url()` is session-scoped, not per-track — the same URL carries every
track in a session, which is why the device is already mid-fetch of it when
auto-advance fires. `_dispatch_queued_track()` (routes/stream.py) still
calls `target.play()` unconditionally, the same call a fresh `/play` makes,
and `SonosDelivery.play()` (delivery/sonos.py) calls `device.stop()`
whenever transport state isn't already STOPPED — including here, where it's
PLAYING the exact URL about to be reissued. The device flips PLAYING ->
STOPPED in the same second and never recovers; delivered bytes (622KB over
0.5s) confirm essentially nothing reached it.

**Not a deterministic bug**: the identical sequence (`transport state before
dispatch: PLAYING` on an auto-advance, same session URL, `device.stop()`
called) appears 14 other times in the same 6h log window today alone, all of
them succeeding without incident — e.g. 15:24:04, immediately followed by a
clean calibration and normal position-resync ticks. If this is real, it's a
narrow race between our own stop()+SetAVTransportURI+Play cycle and the
device's own in-flight handling of the connection it's already reading from,
not something that reproduces on every auto-advance.

**Also encountered while chasing this, and worth separating out**: a
genuinely unrelated, expected event initially looked like a second instance
of the same thing — a device the *user* paused directly (not through
Beacon) shows up identically in the log to an unexplained drop (clean FIN,
`TransportStatus` unchanged, resync reads the frozen position as an
"external position change"). That ambiguity is deliberate/already documented
(see [Cast device drops mid-track - symptom](mid-track-drop-symptom.md),
"What Beacon does about it") — don't mistake a manual device-side stop for a
repro of this entry.

**Secondary, confirmed-real finding along the way:** `_resync_position_once()`
(routes/playback.py) has no guard against the device having actually
stopped/paused before trusting a `get_position()` reading as a legitimate
external seek — visible above at 20:31:17, where the already-stopped
device's stale `0.00s` reading gets read as "external position change" and
corrupts `position_offset` by -7.38s. Doesn't cause a drop by itself (this
one was already broken by then) but pollutes the diagnostic picture whenever
a drop coincides with a resync tick, and would show as a visible position/
lyrics/visualizer jump if the device recovered on its own instead of timing
out. Fixing it cleanly needs either an extra transport-state round trip in
the resync loop (device.get_current_transport_info(), a second SOAP call per
8s tick) or feeding core/upnp_events.py's (currently deliberately log-only)
push events back into playback state — both real design decisions, not
attempted here.

**Attempted and reverted (2026-08-24):** a flat magnitude cap on the
backward `change` in `_resync_position_once()` (mirroring
`MAX_PLAUSIBLE_POSITION_LEAD`) turns out unable to separate the two cases
that matter, because magnitude alone doesn't correlate with which one it is:
this drop's actual corruption was `change=-7.38s` (-0.70s -> -8.08s), smaller
than the `change=-40s` mid-track rewind
`test_resync_position_once_still_recalibrates_a_real_rewind_well_before_
duration` already asserts must still recalibrate normally. Any single
threshold either lets the real incident through (>=7.38s) or breaks that
already-intentional test (<=40s) - there is no value that does both, so no
value belongs here. A real fix needs a signal this function doesn't have:
whether the device's transport is actually still playing (see the "secondary,
confirmed-real finding" above for the same gap, and its own note on what
closing it would cost - an extra SOAP round trip per tick, or feeding UPnP
eventing back into playback state instead of leaving it log-only).

**Next step if this recurs:** capture a packet trace across the recurrence
(see [Instrumentation](instrumentation.md) for what's proven useful before) —
specifically whether SetAVTransportURI lands on the wire while the device's
existing GET to the same URL is still open, and whether the device's FIN/RST
precedes or follows our own `device.stop()` SOAP call. One occurrence isn't
enough to change `_dispatch_queued_track()`/`SonosDelivery.play()` against a
call pattern that otherwise works.

**Addendum:** the listener also tried "Resume" on the interruption toast
~10 minutes after this drop and got silence with no error — that turned out
to be a second, independent bug (the clock was never frozen at the drop, so
the resume seeked FFmpeg past the track's own end), fixed separately - see
[Resuming an old interruption seeked past the track's own end](fixed-resume-seeked-past-track-end.md).
It explains that follow-on symptom but says nothing about why the device
stopped in the first place — this entry is still open.

**Reattributed to the test-suite leak, 2026-08-26.** The "pure coincidence"
call above didn't hold up to the same standard the rest of this file family
uses elsewhere: rows 12-14 in
[the shared symptom file's drops table](mid-track-drop-symptom.md) each show
an exact `pytest -q` start time and how many seconds before the drop it
began; this entry's own pytest-timing check never got that same treatment,
just the bare assertion above. Once actually looked at the same way, *all
six* room-A incidents that evening - this one at 20:31 plus the five
mid-track drops at 21:14-23:00 - coincided with a backend test run, not five
of six.

That also removes the reason to treat this as a separate mechanism in the
first place. "Beacon's own `device.stop()` call causing the stop" was never
in question - it's the shape every auto-advance onto a still-playing device
takes, and it succeeds 14 other times in the same log window. What
distinguishes this one failure from those 14 successes was never explained
by the stop()-call observation alone; a foreign SOAP burst landing on the
device at exactly that moment - Sonos's small concurrent-connection budget
exhausted by the leaking test's SSDP scan plus repeated
`get_current_track_info`, on top of the stop()+reissue cycle already in
flight - is a more complete account of why this specific attempt didn't
recover than "unrelated race, chance timing" was.

Not independently wire-confirmed, same caveat as
[the leak file](mid-track-drop-test-suite-sonos-leak.md) carries for its
other five rows. Downgrade back to open the same way that file would: a
recurrence of this exact shape (auto-advance onto a device still PLAYING the
same session URL, flips to STOPPED within the same second, never recovers)
with no test run anywhere near it.
