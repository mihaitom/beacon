import { defineStore } from 'pinia'
import type { ThemeInstance } from 'vuetify'
import { accountScopedKey } from '@/services/accountKey'
import { appAccent, themeAccent } from '@/services/appAccent'
import { hexToTriplet, isHexColor, towardsContrast, tripletToHex } from '@/services/themeColors'
import {
  DEFAULT_CUSTOM_COLORS,
  MAX_CUSTOM_THEMES,
  nightTheme,
  sanitizeCustomThemes,
  sanitizeThemePreference,
  themeDefinitions,
  type CustomTheme,
  type CustomThemeColors,
  type ThemeId,
  type ThemePreference,
} from '@/plugins/theme'

// Which theme is on is per device, not per account: it is already needed on
// the login page, before there is an account to scope it to, and a phone and
// a desktop are often wanted differently. The list of self-made themes
// belongs to the account (services/connect/accountSettings.ts); only the one
// that is on is kept with the device as well, for that same login page.
const STORAGE_KEY = 'beacon.theme'
const THEMES_KEY = 'beacon.customThemes'

// A colour picker reports every step of a drag, and a name every keystroke.
const PUSH_DEBOUNCE_MS = 800

let pushTimer: ReturnType<typeof setTimeout> | undefined

function pushCustomThemes(themes: CustomTheme[]): void {
  const customThemes = themes.map((theme) => ({ ...theme }))
  void import('@/services/connect/accountSettings').then(({ pushAccountSettings }) =>
    pushAccountSettings({ customThemes }).catch(() => {}),
  )
}

interface StoredAppearance {
  theme?: unknown
  onCustomTheme?: CustomTheme | null
  adaptiveAccent?: unknown
  customThemes?: unknown
  custom?: unknown
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Earlier versions kept the themes with the device. Under the bare key,
 * accountScopedKey() hands them to the first account that signs in. */
function moveListToAccount(stored: StoredAppearance): StoredAppearance {
  const { theme, customThemes } = sanitizeThemePreference(stored)
  const moved: StoredAppearance = {
    theme,
    onCustomTheme: customThemes.find((custom) => custom.id === theme) ?? null,
    adaptiveAccent: stored.adaptiveAccent,
  }
  try {
    if (customThemes.length) localStorage.setItem(THEMES_KEY, JSON.stringify(customThemes))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(moved))
  } catch {
    // Non-critical - it is tried again at the next launch.
  }
  return moved
}

function loadStored(): StoredAppearance | null {
  const stored = readJson(STORAGE_KEY)
  if (typeof stored !== 'object' || stored === null) return null
  return 'customThemes' in stored || 'custom' in stored
    ? moveListToAccount(stored)
    : (stored as StoredAppearance)
}

function loadAccountThemes(): CustomTheme[] | null {
  const raw = readJson(accountScopedKey(THEMES_KEY))
  return raw === null ? null : sanitizeCustomThemes(raw)
}

export function loadThemePreference(): ThemePreference {
  const stored = loadStored()
  return sanitizeThemePreference({
    theme: stored?.theme,
    customThemes: stored?.onCustomTheme ? [stored.onCustomTheme] : [],
  })
}

/** The theme, plus how Now Playing may change it. */
export interface AppearanceState extends ThemePreference {
  /** Whether Now Playing lends the whole app the artist background's
   * colour (see NowPlayingPresentation.vue's borrowedAccent). On unless
   * switched off. */
  adaptiveAccent: boolean
}

function loadAppearance(): AppearanceState {
  const preference = loadThemePreference()
  const themes = loadAccountThemes()
  return {
    ...(themes
      ? sanitizeThemePreference({ theme: preference.theme, customThemes: themes })
      : preference),
    adaptiveAccent: loadStored()?.adaptiveAccent !== false,
  }
}

/** Points Vuetify at a preference: a self-made theme's colours can change
 * while it is the current one, so its definitions are replaced before the
 * switch rather than only registered once. */
export function applyThemePreference(theme: ThemeInstance, preference: ThemePreference): void {
  const definitions = themeDefinitions(preference)
  for (const [name, definition] of Object.entries(definitions)) {
    if (name.startsWith('custom')) theme.themes.value[name] = definition as never
  }
  void theme.change(preference.theme)
  applyThemeAccents(preference)
}

/** The accents the canvas components and Now Playing's fallbacks use,
 * which no CSS variable can hand them (see services/appAccent.ts). */
function applyThemeAccents(preference: ThemePreference): void {
  const definitions = themeDefinitions(preference)
  appAccent.value = hexToTriplet(definitions[preference.theme]!.colors!.primary as string)
  themeAccent.value = hexToTriplet(definitions[nightTheme(preference)]!.colors!.primary as string)
}

/** Startup: Vuetify already starts in the stored theme (main.ts hands it
 * themeOptions()), but the accents outside it have to be set as well -
 * left to the first change, a reload drew the waveform and Now Playing's
 * fallback in Beacon's amber whatever the theme. Then follows every
 * change. */
export function initTheme(
  theme: ThemeInstance,
  store: ReturnType<typeof useAppearanceStore>,
): void {
  applyThemeAccents(store.$state)
  store.$subscribe(() => applyThemePreference(theme, store.$state))
}

// A borrowed accent on a light page: as far towards black as it takes to
// read there, the same floor the presets' own accents keep.
const BORROWED_ACCENT_CONTRAST = 4.5

type ThemeColorsTable = Record<string, { colors: Record<string, unknown> }>

/**
 * Puts an "r, g, b" colour into the theme's primary - Now Playing's
 * artwork colour, which the whole app's accent follows while it is open -
 * or, with null, gives the theme its own back. The night theme takes the
 * colour as it is (it was picked to stand off a dark picture); a light
 * theme gets it darkened until it reads on the page.
 *
 * Goes through the theme objects rather than --v-theme-primary directly so
 * Vuetify re-derives `on-primary` with it.
 */
export function borrowAccent(
  themes: ThemeColorsTable,
  preference: ThemePreference,
  color: string | null,
): void {
  const definitions = themeDefinitions(preference)
  const night = nightTheme(preference)
  for (const name of new Set([preference.theme, night])) {
    const own = definitions[name]!.colors!
    const target = themes[name]?.colors
    if (!target) continue
    if (color === null) {
      target.primary = own.primary
    } else if (name === night) {
      target.primary = tripletToHex(color)
    } else {
      target.primary = towardsContrast(
        tripletToHex(color),
        own.background as string,
        BORROWED_ACCENT_CONTRAST,
      )
    }
  }
  const current = themes[preference.theme]?.colors.primary
  appAccent.value =
    typeof current === 'string'
      ? hexToTriplet(current)
      : (color ?? hexToTriplet(definitions[preference.theme]!.colors!.primary as string))
}

export const useAppearanceStore = defineStore('appearance', {
  state: (): AppearanceState => loadAppearance(),
  getters: {
    /** The theme of the parts that stay dark on a light theme - see
     * plugins/theme.ts's nightTheme(). */
    nightTheme(state): string {
      return nightTheme(state)
    },
    selectedCustomTheme(state): CustomTheme | null {
      return state.customThemes.find((theme) => theme.id === state.theme) ?? null
    },
  },
  actions: {
    setTheme(theme: ThemeId): void {
      this.theme = theme
      this.persist()
    },

    setAdaptiveAccent(enabled: boolean): void {
      this.adaptiveAccent = enabled
      this.persist()
    },

    /** Changes the theme that is on, which has to be a self-made one. */
    setCustomColors(colors: Partial<CustomThemeColors>): void {
      const valid = Object.fromEntries(
        Object.entries(colors).filter(([, value]) => isHexColor(value)),
      )
      this.updateSelected(valid)
    },

    renameCustomTheme(name: string): void {
      this.updateSelected({ name })
    },

    updateSelected(change: Partial<CustomTheme>): void {
      this.customThemes = sanitizeCustomThemes(
        this.customThemes.map((theme) =>
          theme.id === this.theme ? { ...theme, ...change } : theme,
        ),
      )
      this.saveCustomThemes()
    },

    /** Starts from the colours of the self-made theme that is on, since a
     * new one is often a variation of it. Turned on straight away. */
    addCustomTheme(name: string): void {
      if (this.customThemes.length >= MAX_CUSTOM_THEMES) return
      const { background, primary } = this.selectedCustomTheme ?? DEFAULT_CUSTOM_COLORS
      // Not crypto.randomUUID(): a Docker install on plain http has none.
      const id = `custom-${Math.random().toString(36).slice(2, 10)}` as const
      this.customThemes = sanitizeCustomThemes([
        ...this.customThemes,
        { id, name, background, primary },
      ])
      this.theme = id
      this.saveCustomThemes()
    },

    deleteCustomTheme(id: string): void {
      this.customThemes = this.customThemes.filter((theme) => theme.id !== id)
      if (this.theme === id) this.theme = 'beacon'
      this.saveCustomThemes()
    },

    /** The account's list, from the server. Not sent back: it just came
     * from there. */
    adoptCustomThemes(raw: unknown): void {
      const next = sanitizeThemePreference({ theme: this.theme, customThemes: raw ?? [] })
      this.customThemes = next.customThemes
      this.theme = next.theme
      this.persist()
      this.persistAccountThemes()
    },

    /** The list of whoever just signed in. A self-made theme of the previous
     * account cannot stay on, and a change still waiting to go out was its
     * change. */
    reloadForAccount(): void {
      clearTimeout(pushTimer)
      const next = sanitizeThemePreference({
        theme: this.theme,
        customThemes: loadAccountThemes() ?? [],
      })
      this.customThemes = next.customThemes
      this.theme = next.theme
      this.persist()
    },

    /** For an account the server has no list for yet. */
    shareCustomThemes(): void {
      if (this.customThemes.length) pushCustomThemes(this.customThemes)
    },

    saveCustomThemes(): void {
      this.persist()
      this.persistAccountThemes()
      clearTimeout(pushTimer)
      pushTimer = setTimeout(() => pushCustomThemes(this.customThemes), PUSH_DEBOUNCE_MS)
    },

    persist(): void {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            theme: this.theme,
            onCustomTheme: this.selectedCustomTheme,
            adaptiveAccent: this.adaptiveAccent,
          }),
        )
      } catch {
        // Non-critical - the theme just doesn't survive to the next launch.
      }
    },

    persistAccountThemes(): void {
      try {
        localStorage.setItem(accountScopedKey(THEMES_KEY), JSON.stringify(this.customThemes))
      } catch {
        // Non-critical - the account's copy on the server still has them.
      }
    },
  },
})
