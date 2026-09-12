# The phone's volume slider ignored drags

Six attempts over one day, five of them on the wrong cause. Written down
mostly for the theories that were ruled out.

## Symptom

While casting to a speaker, the volume slider on the phone's Now Playing
screen did not follow the finger: it moved a few percent and stopped, or did
not move at all, and roughly every second drag failed to land on the level
being set. Slider and speaker were always in sync with each other - this was
never a display bug.

Two observations decided it, and both came late:

- **Tapping a position always worked. Dragging did not.** A tap needs no
  move tracking; a drag does.
- **It reproduced on no emulator.** Desktop browser in phone mode: fine.
  Real hardware: broken. An emulated drag travels exactly horizontally; a
  finger never does.

## Cause

Vuetify's `VSlider` binds its gesture entirely passively
(`onTouchstartPassive`, and `moveListenerOptions = { passive: true }` in
`vuetify/lib/components/VSlider/slider.js`). A passive listener cannot call
`preventDefault()`, so the component has no way to stop the browser deciding
mid-gesture that the drag was a page scroll. The only remaining lever is
`touch-action` in CSS, and on real hardware that was not enough.

The fix is `components/mobile/TouchVolumeSlider.vue`: a native
`<input type="range">`, which the browser drags itself, so there is no
gesture to lose. The LAN remote has always used one and never had this
problem (`connect/static/remote/js/views/now-playing.js`) - the same element,
styled to match.

## Ruled out

Each of these was implemented, shipped and tested against real hardware
before being ruled out. All four remain in the tree; none of them fixed the
reported symptom.

- **Flooding the speaker.** A drag sent one command per move, ~25 per drag,
  unserialised. Real, and worth fixing (`services/connect/volumeWrite.ts`),
  but not this.
- **Readings fighting the user.** A device's own reading landing on top of a
  change in progress (`services/connect/volumeGuard.ts`). Real for the
  keyboard and wheel paths. Not this: slider and speaker were never out of
  sync with each other.
- **The settle window expiring mid-write.** The 2.5s window could run out
  while a Sonos write - which carries the SSDP discovery cost - was still
  unanswered. Real, closed by holding the guard while anything is queued or
  in flight. Not this.
- **`touch-action` covering only the track.** The track is 6px high inside a
  32px control; the rest resolved to `.v-slider__container` at
  `touch-action: auto`. Real, and measured in Chromium. Moving the rule to
  the control itself did not fix the drag either, because the component
  cannot enforce it against the browser anyway.

## What made it take six attempts

Every test written along the way passed while the bug was live:

- The browser-level drag harness fired `touchstart` at
  `.v-slider-thumb` - it hit the thumb dead-centre every time, which is the
  one case that was never broken.
- The guard test checked `acceptsVolumeReading()` one step _after_ the
  moment the race occurs.
- The `touch-action` test read the track's own computed value, which was the
  6px that did work.

A test that drives the thing under test more precisely than a user can will
pass regardless. The question worth asking earlier: _does the emulator do
this too?_ - and _does the sound move, or only the display?_
