/**
 * Whether the app's background polling should run right now.
 *
 * Two separate reasons it shouldn't, deliberately behind one question so
 * every poller answers both by asking once:
 *
 *  1. **The app is being denied.** A reverse proxy's IPS/WAF answers 403
 *     for a source it has decided to ban, and it keeps answering 403 while
 *     that source keeps asking. Beacon's steady baseline — each active
 *     device's volume every 4s, every open device list its own, the radio
 *     "now playing" tag every 8s — cannot achieve anything during a ban,
 *     but it does keep the detector's bucket topped up and the ban alive.
 *     A 429 says the same thing in plain HTTP. Backing all of it off is
 *     what lets the ban actually expire. See
 *     connect/routes/radio.py's _NEGATIVE_CACHE_CONTROL for the incident.
 *  2. **Nobody is looking.** A minimised window or a background tab
 *     produced exactly the same request rate as one being used, for
 *     readings nothing renders. "Generate fewer requests in the
 *     background" has been point 2 of the fix list in
 *     docs/playback-bugs/mid-track-drop-reverse-proxy-403.md since that
 *     outage.
 *
 * Deliberately a gate the pollers ask rather than something fetchConnect
 * enforces on its own: a request the user just made by clicking something
 * must still go out during a backoff — they are entitled to see it fail —
 * and only the caller knows which kind it is.
 */

// How long to stop polling for after being denied, growing while the
// denials keep coming and reset by the first answer that works. The first
// step is longer than any of the polls' own intervals on purpose: a step
// shorter than the cadence it is meant to interrupt changes nothing.
const BACKOFF_STEPS_MS = [30_000, 60_000, 120_000, 300_000]

// A server is free to ask for longer than we would have waited; it is not
// free to park the app for an hour.
const MAX_RETRY_AFTER_MS = 600_000

let backoffUntil = 0
let consecutiveDenials = 0

/** Whether a background poll should go out now. */
export function pollingAllowed(): boolean {
  return !isBackingOff() && !isHidden()
}

/** Whether the app is currently backing off after being denied. Separate
 * from pollingAllowed() for callers that hold a connection rather than
 * making a request — ReconnectingEventSource has its own reason to stay
 * open in a hidden tab (it is how playback state arrives at all), but no
 * reason at all to keep reconnecting into a ban. */
export function isBackingOff(): boolean {
  return Date.now() < backoffUntil
}

/** How much longer the backoff has to run, 0 if there is none. */
export function backoffRemainingMs(): number {
  return Math.max(0, backoffUntil - Date.now())
}

/**
 * Records what a request to the connect backend came back as.
 *
 * `detail` is what tells a denial by something in front of the backend
 * apart from one by the backend itself: every HTTPException FastAPI raises
 * carries a JSON `detail` (the SERVER_LOCK rejection in routes/devices.py
 * is a real, legitimate 403 of exactly that shape), while a proxy's own
 * refusal carries HTML, or nothing. Same reasoning http.ts already applies
 * to a bare 404. Treating our own 403 as a ban would park every poll in
 * the app over a configuration message.
 */
export function noteResponseStatus(
  status: number,
  headers: { get(name: string): string | null },
  detail: string | null,
): void {
  if (status === 429 || (status === 403 && detail === null)) {
    consecutiveDenials += 1
    const step =
      BACKOFF_STEPS_MS[Math.min(consecutiveDenials - 1, BACKOFF_STEPS_MS.length - 1)] ??
      BACKOFF_STEPS_MS[0]!
    const asked = retryAfterMs(headers.get('Retry-After'))
    backoffUntil = Date.now() + Math.max(step, asked)
    return
  }
  if (status >= 200 && status < 400) {
    consecutiveDenials = 0
    backoffUntil = 0
  }
}

/** Retry-After is either a number of seconds or an HTTP date. Anything
 * else, and anything absurd, is ignored in favour of our own step. */
function retryAfterMs(value: string | null): number {
  if (!value) return 0
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.min(ms, MAX_RETRY_AFTER_MS)
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** Test seam — the backoff is module state that outlives any one test. */
export function _resetPollGate(): void {
  backoffUntil = 0
  consecutiveDenials = 0
}
