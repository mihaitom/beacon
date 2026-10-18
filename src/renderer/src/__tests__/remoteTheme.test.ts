import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CUSTOM_COLORS, remotePalette } from '@/plugins/theme'
import { contrast } from '@/services/themeColors'

/** The Remote Control in the desktop's theme: what the renderer sends
 * (plugins/theme.ts's remotePalette()) and what the phone does with it
 * (connect/static/remote/js/theme.js), driven with real DOM. */

const REMOTE = resolve(__dirname, '../../../../connect/static/remote/js')

async function loadTheme() {
  // Fresh per test: the module remembers the palette it last applied.
  vi.resetModules()
  return import(
    /* @vite-ignore */ pathToFileURL(resolve(REMOTE, 'theme.js')).href + `?t=${Date.now()}`
  )
}

const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name)

describe('remotePalette', () => {
  it("is the chosen theme's own colours", () => {
    const palette = remotePalette({ theme: 'paper', custom: DEFAULT_CUSTOM_COLORS })
    expect(palette.dark).toBe(false)
    expect(palette.background).toBe('#F6F2EA')
    expect(palette.accent).toBe('#9E5800')
    expect(palette.text).toBe('#24201A')
  })

  it('keeps text on the accent readable', () => {
    for (const theme of ['beacon', 'graphite', 'paper', 'glacier'] as const) {
      const palette = remotePalette({ theme, custom: DEFAULT_CUSTOM_COLORS })
      expect(contrast(palette.accent, palette.accent_on), theme).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('carries a self-made theme too', () => {
    const custom = { background: '#F3EFFA', primary: '#7B3FC4' }
    const palette = remotePalette({ theme: 'custom', custom })
    expect(palette.background).toBe('#F3EFFA')
    expect(palette.accent).toBe('#7B3FC4')
    expect(palette.dark).toBe(false)
  })
})

describe("the Remote Control's theme.js", () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('style')
    document.head.innerHTML = '<meta name="theme-color" content="#12141c" />'
  })

  it("puts the desktop's palette into the page's variables", async () => {
    const { applyTheme } = await loadTheme()
    applyTheme(remotePalette({ theme: 'glacier', custom: DEFAULT_CUSTOM_COLORS }))

    expect(rootVar('--bg')).toBe('#EEF1F5')
    expect(rootVar('--accent')).toBe('#2E6BB0')
    // The triplet the rgba() tints and the waveform are drawn from.
    expect(rootVar('--accent-rgb')).toBe('46, 107, 176')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(
      '#E1E6ED',
    )
  })

  it('leaves the colours alone for a snapshot without a usable palette', async () => {
    const { applyTheme } = await loadTheme()
    applyTheme(undefined)
    applyTheme({
      ...remotePalette({ theme: 'glacier', custom: DEFAULT_CUSTOM_COLORS }),
      accent: 'blue',
    })
    expect(rootVar('--bg')).toBe('')
  })

  it('starts a reload in the colours from last time', async () => {
    const first = await loadTheme()
    first.applyTheme(remotePalette({ theme: 'graphite', custom: DEFAULT_CUSTOM_COLORS }))
    document.documentElement.removeAttribute('style')

    const second = await loadTheme()
    second.restoreTheme()
    expect(rootVar('--accent')).toBe('#4FD1C5')
  })
})
