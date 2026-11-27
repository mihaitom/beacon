// The guest page has no app stores (CLAUDE.md, "Now Playing is shared with
// party guests"): one statically imported drags in the whole store layer,
// which once grew the guest page's bundle by a tenth and ran the app's
// login code on it. A lazy import() is fine - its chunk is only fetched when
// called - so only static imports are followed here.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = 'src/renderer/src'
const ENTRY = join(SRC, 'party/main.ts')

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm

function resolve(spec: string, from: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = normalize(join(dirname(from), spec))
  else return null
  for (const candidate of [base, `${base}.ts`, `${base}.vue`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && candidate.match(/\.(ts|vue)$/)) return candidate
  }
  return null
}

/** Each module reachable from the entry, with the module that imports it. */
function reachable(entry: string): Map<string, string | null> {
  const seen = new Map<string, string | null>([[entry, null]])
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()!
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      const target = resolve(spec!, file)
      if (target && !seen.has(target)) {
        seen.set(target, file)
        queue.push(target)
      }
    }
  }
  return seen
}

function chain(seen: Map<string, string | null>, file: string): string {
  const path: string[] = []
  for (let at: string | null = file; at; at = seen.get(at) ?? null) path.unshift(at)
  return path.join(' -> ')
}

describe('the guest page bundle', () => {
  it('reaches none of the app stores', () => {
    const seen = reachable(ENTRY)
    const stores = [...seen.keys()].filter((file) => file.startsWith(join(SRC, 'stores/')))
    expect(stores.map((file) => chain(seen, file))).toEqual([])
  })
})
