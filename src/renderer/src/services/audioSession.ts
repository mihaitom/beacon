/** Declares this page as a media-playback session, which is the one thing
 * iOS wants before it will keep a web player running in the background.
 *
 * Without it, Safari treats the page as an ambient audio source: the current
 * song plays on through a screen lock, but the moment that song ends Safari
 * will not start the next one from a suspended page, so a queue stops at the
 * end of whichever track was playing when the phone was locked. It is a
 * long-standing WebKit bug that regresses across iOS versions (221413, and
 * 261554 for the same symptom from iOS 17.2.1 on), so nothing on this side
 * can be relied on to fix it - declaring the session is the documented way
 * out.
 *
 * A nice side effect on the same API call: a playback session is not muted
 * by the hardware ringer/silent switch, which is what any music player
 * wants and what the page would otherwise get wrong on an iPhone.
 *
 * Only Safari exposes this (16.4+, iOS 17+); everywhere else, the Electron
 * app and the Chromium browsers included, it is absent and this is a no-op. */

// The browser's AudioSession, which the DOM lib does not type yet. `type` is
// the only property used here.
interface AudioSessionLike {
  type: 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record'
}

function audioSession(): AudioSessionLike | null {
  return (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession ?? null
}

function apply(): void {
  const session = audioSession()
  if (!session) return
  try {
    session.type = 'playback'
  } catch {
    // A browser exposing the object but rejecting this value: losing the
    // session declaration is a degradation, throwing here in the middle of
    // playback startup is not.
  }
}

let initialized = false

/** Called once from playbackStore.init() (the app) and party/main.ts (the
 * guest page) - the two places a page of Beacon's plays local audio. */
export function initAudioSession(): void {
  if (initialized) return
  initialized = true
  apply()
  // Safari only honours the session type once the page has been interacted
  // with, so it is asserted again on the first gesture and the listeners
  // removed then. Capture phase, so an inner handler calling
  // stopPropagation() cannot keep the gesture from reaching this. Several
  // event types, not just one: pointerdown is too early on some iOS
  // versions and click too late on others.
  const onGesture = (): void => {
    apply()
    window.removeEventListener('pointerdown', onGesture, true)
    window.removeEventListener('touchend', onGesture, true)
    window.removeEventListener('click', onGesture, true)
  }
  window.addEventListener('pointerdown', onGesture, true)
  window.addEventListener('touchend', onGesture, true)
  window.addEventListener('click', onGesture, true)
}
