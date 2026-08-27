// Packaging config, checked from the renderer's test suite because it is
// the only JavaScript one this repo has — nothing here touches the app
// itself. It exists because the packaged icon has now been wrong three
// times (0.1.2 and 0.1.3 both carry an icon fix, and the Linux one was
// still broken after them), and each time it was only noticed by
// installing a finished build and looking at a launcher.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(__dirname, '../../../..')

/** The largest size the freedesktop hicolor theme declares. A PNG in a
 * directory the theme doesn't know about — 1024x1024, say — is skipped by
 * every spec-conforming icon lookup, which is exactly how the Linux build
 * ended up with no icon at all: electron-builder shipped a single
 * 1024x1024 file and nothing found it. */
const LARGEST_HICOLOR_SIZE = 512

function builderConfig(): string {
  return readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf8')
}

/** The `icon:` line inside the given top-level section. */
function iconFor(section: 'linux' | 'win' | 'mac'): string {
  const config = builderConfig()
  const start = config.indexOf(`\n${section}:`)
  expect(start, `${section} section`).toBeGreaterThan(-1)
  const rest = config.slice(start + 1)
  const match = rest.match(/^\s+icon:\s*(\S+)\s*$/m)
  expect(match, `${section} icon`).not.toBeNull()
  return match![1]!
}

function pngSize(file: string): { width: number; height: number } {
  // PNG header: 8-byte signature, then an IHDR chunk whose width and
  // height are big-endian 32-bit at offsets 16 and 20.
  const buffer = readFileSync(file)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

describe('packaged icons', () => {
  it('points Linux at a directory, not at a single image', () => {
    // Handed one .png, electron-builder ships exactly that file at exactly
    // its own resolution — one size, and if that size is 1024 it lands
    // somewhere no launcher looks.
    const icon = iconFor('linux')

    expect(icon).toBe('build/icons')
    expect(readdirSync(resolve(ROOT, icon)).length).toBeGreaterThan(0)
  })

  it('ships the icon in sizes the hicolor theme actually declares', () => {
    const files = readdirSync(resolve(ROOT, 'build/icons')).filter((n) => n.endsWith('.png'))
    const sizes = files
      .map((name) => /^(\d+)x\d+\.png$/.exec(name)?.[1])
      .filter((size): size is string => size != null)
      .map(Number)
      .sort((a, b) => a - b)

    // The small end matters as much as the large one: a launcher asking
    // for 16px otherwise scales a 512px image down on every draw.
    expect(sizes).toContain(16)
    expect(sizes).toContain(48)
    expect(sizes).toContain(LARGEST_HICOLOR_SIZE)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(LARGEST_HICOLOR_SIZE)
  })

  it('gives each file the dimensions its name claims', () => {
    // electron-builder derives the hicolor directory from the *filename*,
    // so a mislabelled file is filed under a size it isn't.
    const dir = resolve(ROOT, 'build/icons')
    for (const name of readdirSync(dir)) {
      const match = /^(\d+)x(\d+)\.png$/.exec(name)
      if (!match) continue
      const { width, height } = pngSize(resolve(dir, name))
      expect({ name, width, height }).toEqual({
        name,
        width: Number(match[1]),
        height: Number(match[2]),
      })
    }
  })

  it('leaves Windows and macOS on their own formats', () => {
    // Both want a single container file rather than a set, and neither is
    // affected by the hicolor rules above.
    expect(iconFor('win')).toBe('build/icons/icon.ico')
    expect(iconFor('mac')).toBe('build/icon.png')
  })
})
