import { fetchConnect } from './http'

/** Puts connect's test tone - a distinct beep every two seconds - on the
 * speaker that is casting, in place of the song. Only there while the
 * backend runs at DEBUG or TRACE (routes/debug.py). */
export async function playTestTone(): Promise<void> {
  await fetchConnect('/debug/play-test-tone', { method: 'POST' })
}
