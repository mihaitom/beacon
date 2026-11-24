/** The presets this device cannot draw, remembered here and nowhere else:
 * it is about the graphics card, so the account's other devices are not
 * held back by it.
 *
 * A preset lands on the list two ways: the picture gave up on it (far too
 * slow even at the smallest size, see resolution.ts), or the page died
 * while it was starting - the browser hung on it and was closed by force.
 * For that, a preset is noted as starting before its shaders compile and
 * cleared once it has drawn for a while; one still noted at the next load
 * never got there. Without that the same preset would start again the
 * moment Now Playing opened, with no way left to reach the switch. */

const TOO_HEAVY_KEY = 'beacon.milkdrop.tooHeavy'
const STARTING_KEY = 'beacon.milkdrop.starting'

function read(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(TOO_HEAVY_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : []
  } catch {
    return []
  }
}

function write(keys: string[]): void {
  try {
    localStorage.setItem(TOO_HEAVY_KEY, JSON.stringify(keys))
  } catch {
    // Without storage the list lasts as long as the page.
  }
}

/** Takes in a start that never finished, from before this page load. */
function adoptUnfinishedStart(): void {
  try {
    const starting = localStorage.getItem(STARTING_KEY)
    if (starting === null) return
    localStorage.removeItem(STARTING_KEY)
    markTooHeavy(starting)
  } catch {
    // Nothing to adopt.
  }
}

let adopted = false

/** Once per page load, before this load notes a start of its own. */
function ensureAdopted(): void {
  if (adopted) return
  adopted = true
  adoptUnfinishedStart()
}

export function tooHeavyHere(): Set<string> {
  ensureAdopted()
  return new Set(read())
}

/** `keys` without the ones this device cannot draw. */
export function drawableHere(keys: readonly string[]): string[] {
  const tooHeavy = tooHeavyHere()
  return keys.filter((key) => !tooHeavy.has(key))
}

export function markTooHeavy(key: string): void {
  const keys = read()
  if (!keys.includes(key)) write([...keys, key])
}

/** Picked by hand: the listener wants to try it again. */
export function forgetTooHeavy(key: string): void {
  write(read().filter((other) => other !== key))
}

export function noteStarting(key: string): void {
  ensureAdopted()
  try {
    localStorage.setItem(STARTING_KEY, key)
  } catch {
    // Then a hang goes unnoticed, as before.
  }
}

/** It drew, or the page closed normally before it could. */
export function clearStarting(key?: string): void {
  try {
    if (key === undefined || localStorage.getItem(STARTING_KEY) === key) {
      localStorage.removeItem(STARTING_KEY)
    }
  } catch {
    // Nothing to clear.
  }
}
