import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  MAX_CUSTOM_THEMES,
  customTheme,
  nightTheme,
  sanitizeThemePreference,
  themeDefinitions,
  themeOptions,
  type ThemePreference,
} from '@/plugins/theme'
import { contrast, hexToTriplet } from '@/services/themeColors'
import { useAuthStore } from '@/stores/auth'
import { DEFAULT_APP_ACCENT, appAccent, themeAccent } from '@/services/appAccent'

const KEY = 'beacon.theme'

const { pushAccountSettings } = vi.hoisted(() => ({
  pushAccountSettings: vi.fn(
    async (_patch: { customThemes?: { primary: string }[] }) => ({}) as unknown,
  ),
}))
vi.mock('@/services/connect/accountSettings', () => ({ pushAccountSettings }))

const prefer = (theme: ThemePreference['theme'], colors = DEFAULT_CUSTOM_COLORS) => ({
  theme,
  customThemes: theme.startsWith('custom')
    ? [{ id: theme as `custom${string}`, name: '', ...colors }]
    : [],
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

function signIn(username: string): void {
  Object.assign(useAuthStore(), {
    serverUrl: 'https://music.example',
    username,
    authenticated: true,
  })
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
        theme: 'custom-a',
        customThemes: [{ id: 'custom-a', name: 'x', background: 'blue', primary: '#abcdef' }],
      }).customThemes,
    ).toEqual([
      {
        id: 'custom-a',
        name: 'x',
        background: DEFAULT_CUSTOM_COLORS.background,
        primary: '#ABCDEF',
      },
    ])
  })

  it('keeps the one theme somebody made before there could be several', () => {
    const colours = { background: '#101820', primary: '#E07A5F' }
    const chosen = sanitizeThemePreference({ theme: 'custom', custom: colours })
    expect(chosen.theme).toBe('custom')
    expect(chosen.customThemes).toEqual([{ id: 'custom', name: '', ...colours }])

    const notChosen = sanitizeThemePreference({ theme: 'paper', custom: colours })
    expect(notChosen.theme).toBe('paper')
    expect(notChosen.customThemes).toHaveLength(1)
  })

  it('does not invent a theme from colours nobody touched', () => {
    expect(
      sanitizeThemePreference({ theme: 'paper', custom: DEFAULT_CUSTOM_COLORS }).customThemes,
    ).toEqual([])
  })

  it('falls back to Beacon when the chosen theme is not there any more', () => {
    expect(sanitizeThemePreference({ theme: 'custom-gone', customThemes: [] }).theme).toBe('beacon')
  })

  it('refuses an id that could not go in a class name', () => {
    const bad = [{ id: 'custom x"><', name: '', background: '#111111', primary: '#222222' }]
    expect(sanitizeThemePreference({ customThemes: bad }).customThemes).toEqual([])
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
    store.addCustomTheme('Mine')
    store.setCustomColors({ primary: '#123456' })
    store.setCustomColors({ background: 'nope' })
    expect(store.selectedCustomTheme).toMatchObject({
      background: DEFAULT_CUSTOM_COLORS.background,
      primary: '#123456',
    })
  })

  it('keeps several themes apart and turns a new one on', () => {
    const store = useAppearanceStore()
    store.addCustomTheme('One')
    store.setCustomColors({ primary: '#111111' })
    const first = store.theme
    store.addCustomTheme('Two')
    store.setCustomColors({ primary: '#222222' })

    expect(store.theme).not.toBe(first)
    expect(store.customThemes.map((t) => [t.name, t.primary])).toEqual([
      ['One', '#111111'],
      ['Two', '#222222'],
    ])
  })

  it('starts a new theme from the self-made one that is on', () => {
    const store = useAppearanceStore()
    store.addCustomTheme('One')
    store.setCustomColors({ background: '#ABCDEF' })
    store.addCustomTheme('Two')
    expect(store.selectedCustomTheme!.background).toBe('#ABCDEF')
  })

  it('stops at the limit', () => {
    const store = useAppearanceStore()
    for (let i = 0; i < MAX_CUSTOM_THEMES + 3; i++) store.addCustomTheme(`T${i}`)
    expect(store.customThemes).toHaveLength(MAX_CUSTOM_THEMES)
    expect(store.selectedCustomTheme).not.toBeNull()
  })

  it('goes back to Beacon when the theme that is on is deleted', () => {
    const store = useAppearanceStore()
    store.addCustomTheme('One')
    store.deleteCustomTheme(store.theme)
    expect(store.theme).toBe('beacon')
    expect(store.customThemes).toEqual([])
  })

  it('leaves the theme on alone when another one is deleted', () => {
    const store = useAppearanceStore()
    store.addCustomTheme('One')
    const one = store.theme
    store.addCustomTheme('Two')
    store.deleteCustomTheme(one)
    expect(store.selectedCustomTheme!.name).toBe('Two')
  })

  it('remembers the themes across a restart', () => {
    useAppearanceStore().addCustomTheme('One')
    setActivePinia(createPinia())
    expect(useAppearanceStore().selectedCustomTheme!.name).toBe('One')
  })

  it('takes over the account list and leaves a theme removed elsewhere', () => {
    const store = useAppearanceStore()
    store.addCustomTheme('Local')
    store.adoptCustomThemes([
      { id: 'custom-b', name: 'Remote', background: '#111111', primary: '#222222' },
    ])
    expect(store.customThemes.map((t) => t.name)).toEqual(['Remote'])
    expect(store.theme).toBe('beacon')
  })

  it('keeps the theme on when the account list still has it', () => {
    const store = useAppearanceStore()
    store.addCustomTheme('Local')
    const id = store.theme
    store.adoptCustomThemes([{ id, name: 'Renamed', background: '#111111', primary: '#222222' }])
    expect(store.theme).toBe(id)
    expect(store.selectedCustomTheme!.name).toBe('Renamed')
  })

  describe('following the account', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      pushAccountSettings.mockClear()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    const pushed = async () => {
      await vi.advanceTimersByTimeAsync(1000)
      await vi.dynamicImportSettled()
      await vi.advanceTimersByTimeAsync(0)
      return pushAccountSettings.mock.calls.map(([patch]) => patch.customThemes)
    }

    it('sends a burst of changes once, with the end result', async () => {
      const store = useAppearanceStore()
      store.addCustomTheme('One')
      for (const primary of ['#111111', '#222222', '#333333']) store.setCustomColors({ primary })
      const calls = await pushed()
      expect(calls).toHaveLength(1)
      expect(calls[0]![0]!.primary).toBe('#333333')
    })

    it('does not send back what came from the server', async () => {
      useAppearanceStore().adoptCustomThemes([])
      expect(await pushed()).toEqual([])
    })

    it('does not send anything for choosing a theme', async () => {
      useAppearanceStore().setTheme('paper')
      expect(await pushed()).toEqual([])
    })

    it('shares an existing list with an account that has none yet', async () => {
      const store = useAppearanceStore()
      store.addCustomTheme('One')
      await pushed()
      pushAccountSettings.mockClear()
      store.shareCustomThemes()
      expect(await pushed()).toHaveLength(1)
    })

    it('shares nothing when there is nothing', async () => {
      useAppearanceStore().shareCustomThemes()
      expect(await pushed()).toEqual([])
    })

    it("does not share one account's themes with the next", async () => {
      signIn('alice')
      const store = useAppearanceStore()
      store.addCustomTheme('Hers')
      await pushed()
      pushAccountSettings.mockClear()

      signIn('bob')
      store.reloadForAccount()
      store.shareCustomThemes()

      expect(await pushed()).toEqual([])
    })

    it('does not send a waiting change with the next account', async () => {
      signIn('alice')
      const store = useAppearanceStore()
      store.addCustomTheme('Hers')

      signIn('bob')
      store.reloadForAccount()

      expect(await pushed()).toEqual([])
    })
  })

  describe('per account', () => {
    const LEGACY = {
      theme: 'custom-a',
      customThemes: [{ id: 'custom-a', name: 'Old', background: '#111111', primary: '#222222' }],
    }

    it('keeps each account its own list', () => {
      signIn('alice')
      const store = useAppearanceStore()
      store.addCustomTheme('Hers')

      signIn('bob')
      store.reloadForAccount()
      expect(store.customThemes).toEqual([])
      store.addCustomTheme('His')

      signIn('alice')
      store.reloadForAccount()
      expect(store.customThemes.map((t) => t.name)).toEqual(['Hers'])
    })

    it("does not leave another account's theme on", () => {
      signIn('alice')
      const store = useAppearanceStore()
      store.addCustomTheme('Hers')
      signIn('bob')
      store.reloadForAccount()
      expect(store.theme).toBe('beacon')
    })

    it('leaves a preset on across accounts', () => {
      signIn('alice')
      const store = useAppearanceStore()
      store.setTheme('glacier')
      signIn('bob')
      store.reloadForAccount()
      expect(store.theme).toBe('glacier')
    })

    it('still has the theme that is on before anyone has signed in', () => {
      signIn('alice')
      useAppearanceStore().addCustomTheme('Mine')
      useAuthStore().$reset()

      const { theme, customThemes } = loadThemePreference()
      expect(customThemes.map((t) => t.name)).toEqual(['Mine'])
      expect(theme).toBe(customThemes[0]!.id)
    })

    it('gives the themes from before this to the first account only', () => {
      localStorage.setItem(KEY, JSON.stringify(LEGACY))
      signIn('alice')
      const store = useAppearanceStore()
      store.reloadForAccount()
      expect(store.customThemes.map((t) => t.name)).toEqual(['Old'])
      expect(store.theme).toBe('custom-a')

      signIn('bob')
      store.reloadForAccount()
      expect(store.customThemes).toEqual([])
    })

    it('keeps the theme from before on for the login page', () => {
      localStorage.setItem(KEY, JSON.stringify(LEGACY))
      expect(loadThemePreference()).toEqual(LEGACY)
    })

    it('does not touch the list when a theme is picked before signing in', () => {
      localStorage.setItem('beacon.customThemes', JSON.stringify(LEGACY.customThemes))
      useAppearanceStore().setTheme('paper')
      expect(JSON.parse(localStorage.getItem('beacon.customThemes')!)).toEqual(LEGACY.customThemes)
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
    applyThemePreference(theme as unknown as ThemeInstance, prefer('custom-a', custom))

    expect(theme.change).toHaveBeenCalledWith('custom-a')
    expect((theme.themes.value['custom-a'] as { colors: { primary: string } }).colors.primary).toBe(
      '#7B3FC4',
    )
    expect(theme.themes.value['custom-a-night']).toBeDefined()
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
