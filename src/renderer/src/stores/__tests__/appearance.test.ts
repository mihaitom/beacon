import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify, type ThemeInstance } from 'vuetify'
import {
  applyThemePreference,
  borrowAccent,
  initTheme,
  loadThemePreference,
  useAppearanceStore,
} from '../appearance'
import {
  DEFAULT_CUSTOM_COLORS,
  customTheme,
  nightTheme,
  sanitizeThemePreference,
  themeDefinitions,
  themeOptions,
  type ThemePreference,
} from '@/plugins/theme'
import { contrast, hexToTriplet } from '@/services/themeColors'
import { DEFAULT_APP_ACCENT, appAccent, themeAccent } from '@/services/appAccent'

const KEY = 'beacon.theme'

const prefer = (theme: ThemePreference['theme'], custom = DEFAULT_CUSTOM_COLORS) => ({
  theme,
  custom,
})

/** What Vuetify keeps per theme, as far as these functions touch it. */
function themesTable(preference: ThemePreference) {
  return Object.fromEntries(
    Object.entries(themeDefinitions(preference)).map(([name, definition]) => [
      name,
      { colors: { ...definition.colors } as Record<string, unknown> },
    ]),
  )
}

describe('theme definitions', () => {
  it('keeps every theme accent readable on its own background', () => {
    const definitions = themeDefinitions(prefer('beacon'))
    for (const [name, definition] of Object.entries(definitions)) {
      const { primary, background } = definition.colors as Record<string, string>
      // The custom default is a user's choice, not ours to vouch for.
      if (name.startsWith('custom')) continue
      expect(contrast(primary!, background!), name).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('gives a light theme a dark night for its artwork parts, and a dark one none', () => {
    expect(nightTheme(prefer('beacon'))).toBe('beacon')
    expect(nightTheme(prefer('graphite'))).toBe('graphite')
    expect(nightTheme(prefer('paper'))).toBe('paper-night')
    expect(nightTheme(prefer('glacier'))).toBe('glacier-night')
    expect(themeDefinitions(prefer('paper'))['paper-night']!.dark).toBe(true)
  })

  it('makes a self-made theme light or dark by its background', () => {
    expect(customTheme({ background: '#101820', primary: '#E07A5F' }).dark).toBe(true)
    expect(customTheme({ background: '#F3EFFA', primary: '#7B3FC4' }).dark).toBe(false)
    expect(nightTheme(prefer('custom', { background: '#F3EFFA', primary: '#7B3FC4' }))).toBe(
      'custom-night',
    )
  })

  it("lifts a light theme's accent until it reads on its night", () => {
    const definitions = themeDefinitions(prefer('paper'))
    const { primary, background } = definitions['paper-night']!.colors as Record<string, string>
    expect(contrast(primary!, background!)).toBeGreaterThanOrEqual(4.5)
  })

  it('falls back to Beacon for anything it does not know', () => {
    expect(sanitizeThemePreference(null)).toEqual(prefer('beacon'))
    expect(sanitizeThemePreference({ theme: 'solarized' }).theme).toBe('beacon')
    expect(
      sanitizeThemePreference({
        theme: 'custom',
        custom: { background: 'blue', primary: '#abcdef' },
      }).custom,
    ).toEqual({ background: DEFAULT_CUSTOM_COLORS.background, primary: '#ABCDEF' })
  })
})

describe('appearance store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('starts on Beacon', () => {
    expect(useAppearanceStore().theme).toBe('beacon')
  })

  it('remembers the theme for this device', () => {
    useAppearanceStore().setTheme('glacier')
    expect(loadThemePreference().theme).toBe('glacier')
    expect(JSON.parse(localStorage.getItem(KEY)!).theme).toBe('glacier')
  })

  it('survives a stored value it cannot read', () => {
    localStorage.setItem(KEY, '{not json')
    expect(loadThemePreference()).toEqual(prefer('beacon'))
  })

  it('takes one custom colour at a time and ignores one that is not a colour', () => {
    const store = useAppearanceStore()
    store.setCustomColors({ primary: '#123456' })
    store.setCustomColors({ background: 'nope' })
    expect(store.custom).toEqual({
      background: DEFAULT_CUSTOM_COLORS.background,
      primary: '#123456',
    })
  })

  it("lets Now Playing follow the artist's colour unless switched off, and remembers that", () => {
    // A value stored before the switch existed has no say: on.
    localStorage.setItem(KEY, JSON.stringify(prefer('graphite')))
    setActivePinia(createPinia())
    expect(useAppearanceStore().adaptiveAccent).toBe(true)

    useAppearanceStore().setAdaptiveAccent(false)
    setActivePinia(createPinia())
    expect(useAppearanceStore().adaptiveAccent).toBe(false)
    expect(useAppearanceStore().theme).toBe('graphite')
  })

  it('names the night of the chosen theme', () => {
    const store = useAppearanceStore()
    store.setTheme('paper')
    expect(store.nightTheme).toBe('paper-night')
  })
})

describe('applyThemePreference', () => {
  function fakeTheme() {
    return {
      themes: { value: {} as Record<string, unknown> },
      change: vi.fn().mockResolvedValue(undefined),
    }
  }

  it('switches Vuetify to the theme, with the current custom colours', () => {
    const theme = fakeTheme()
    const custom = { background: '#F3EFFA', primary: '#7B3FC4' }
    applyThemePreference(theme as unknown as ThemeInstance, prefer('custom', custom))

    expect(theme.change).toHaveBeenCalledWith('custom')
    expect((theme.themes.value.custom as { colors: { primary: string } }).colors.primary).toBe(
      '#7B3FC4',
    )
    expect(theme.themes.value['custom-night']).toBeDefined()
  })

  it("hands the canvas components the theme's accents", () => {
    applyThemePreference(fakeTheme() as unknown as ThemeInstance, prefer('graphite'))
    expect(appAccent.value).toBe(hexToTriplet('#4FD1C5'))
    expect(themeAccent.value).toBe(hexToTriplet('#4FD1C5'))

    applyThemePreference(fakeTheme() as unknown as ThemeInstance, prefer('beacon'))
    expect(appAccent.value).toBe(DEFAULT_APP_ACCENT)
  })
})

describe('initTheme', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    appAccent.value = DEFAULT_APP_ACCENT
    themeAccent.value = DEFAULT_APP_ACCENT
  })

  it("starts the canvas accents in the stored theme's, not Beacon's amber", () => {
    localStorage.setItem(KEY, JSON.stringify(prefer('graphite')))
    const vuetify = createVuetify({ theme: themeOptions(loadThemePreference()) })
    initTheme(vuetify.theme, useAppearanceStore())

    expect(appAccent.value).toBe(hexToTriplet('#4FD1C5'))
    expect(themeAccent.value).toBe(hexToTriplet('#4FD1C5'))
  })

  it('follows a theme picked later', async () => {
    const vuetify = createVuetify({ theme: themeOptions(loadThemePreference()) })
    const store = useAppearanceStore()
    initTheme(vuetify.theme, store)

    store.setTheme('glacier')
    await Promise.resolve()

    expect(vuetify.theme.global.name.value).toBe('glacier')
    expect(appAccent.value).toBe(hexToTriplet('#2E6BB0'))
  })
})

describe('borrowAccent', () => {
  // A pale yellow off an artwork: fine on the dark Now Playing, unreadable
  // on a light page.
  const PALE = '250, 230, 120'

  it('lends a dark theme the colour as it is', () => {
    const preference = prefer('graphite')
    const themes = themesTable(preference)
    borrowAccent(themes, preference, PALE)
    expect(themes.graphite!.colors.primary).toBe('#FAE678')
    expect(appAccent.value).toBe(PALE)
  })

  it('darkens it for a light page and leaves it bright on the night', () => {
    const preference = prefer('paper')
    const themes = themesTable(preference)
    borrowAccent(themes, preference, PALE)

    expect(themes['paper-night']!.colors.primary).toBe('#FAE678')
    const day = themes.paper!.colors.primary as string
    expect(contrast(day, '#F6F2EA')).toBeGreaterThanOrEqual(4.5)
  })

  it('gives the accent back in a real Vuetify, which keeps the themes it is handed', () => {
    const preference = prefer('graphite')
    const vuetify = createVuetify({ theme: themeOptions(preference) })
    const themes = vuetify.theme.themes.value as unknown as Parameters<typeof borrowAccent>[0]

    borrowAccent(themes, preference, PALE)
    borrowAccent(themes, preference, null)

    expect(themes.graphite!.colors.primary).toBe('#4FD1C5')
  })

  it("gives the theme its own accent back, not Beacon's amber", () => {
    const preference = prefer('graphite')
    const themes = themesTable(preference)
    borrowAccent(themes, preference, PALE)
    borrowAccent(themes, preference, null)

    expect(themes.graphite!.colors.primary).toBe('#4FD1C5')
    expect(appAccent.value).toBe(hexToTriplet('#4FD1C5'))
  })
})
