/** The per-song lyrics timing corrections: read from localStorage, so a song
 * opens with its correction without waiting for anything, and kept in step
 * with the account's copy in connect (core/lyrics_offsets.py). */

import { accountScopedKey, getAccountKey } from '@/services/accountKey'
import { fetchConnect } from '@/services/connect/http'

const OFFSETS_KEY = 'beacon.lyricsOffsets'

// A nudge button gets pressed several times in a row.
const PUSH_DEBOUNCE_MS = 1_000
// The most connect takes in one request.
const UPLOAD_BATCH = 500

type Offsets = Record<string, number>

const unsent = new Map<string, number>()
let pushTimer: ReturnType<typeof setTimeout> | undefined

function readAll(): Offsets {
  try {
    return JSON.parse(localStorage.getItem(accountScopedKey(OFFSETS_KEY)) ?? '{}') as Offsets
  } catch {
    return {}
  }
}

function writeAll(offsets: Offsets): void {
  try {
    localStorage.setItem(accountScopedKey(OFFSETS_KEY), JSON.stringify(offsets))
  } catch {
    // Losing a saved offset on write failure (e.g. storage full/disabled)
    // isn't worth surfacing — the in-memory value for this session still works.
  }
}

export function readStoredOffset(songId: string): number {
  return readAll()[songId] ?? 0
}

export function writeStoredOffset(songId: string, offset: number): void {
  const all = readAll()
  if (offset === 0) delete all[songId]
  else all[songId] = offset
  writeAll(all)
}

function send(offsets: Offsets): Promise<unknown> {
  return fetchConnect('/lyrics-offsets', { method: 'PUT', body: { offsets } })
}

function flush(): void {
  const offsets = Object.fromEntries(unsent)
  unsent.clear()
  send(offsets).catch((error) => {
    console.error('[lyrics] Failed to save a correction to the account:', error)
  })
}

/** Zero goes too: it is how another device hears a correction was undone. */
export function pushOffset(songId: string, offset: number): void {
  unsent.set(songId, offset)
  clearTimeout(pushTimer)
  pushTimer = setTimeout(flush, PUSH_DEBOUNCE_MS)
}

/** Brings this device in step with the account. The account wins for songs
 * it knows; what only this device knows goes up, which is also how the
 * corrections from before this existed get there. */
export async function pullLyricsOffsets(): Promise<void> {
  const account = getAccountKey()
  const { offsets: remote } = await fetchConnect<{ offsets: Offsets }>('/lyrics-offsets')
  if (getAccountKey() !== account) return

  const local = readAll()
  const merged = { ...local }
  for (const [songId, seconds] of Object.entries(remote)) {
    if (unsent.has(songId)) continue
    if (seconds === 0) delete merged[songId]
    else merged[songId] = seconds
  }
  writeAll(merged)

  const onlyHere = Object.entries(local).filter(([songId]) => !(songId in remote))
  for (let start = 0; start < onlyHere.length; start += UPLOAD_BATCH) {
    await send(Object.fromEntries(onlyHere.slice(start, start + UPLOAD_BATCH)))
  }
}

export function resetLyricsOffsetsForTests(): void {
  clearTimeout(pushTimer)
  unsent.clear()
}
