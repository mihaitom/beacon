import { defineStore } from 'pinia'
import type { ThemeInstance } from 'vuetify'
import { appAccent, themeAccent } from '@/services/appAccent'
import { hexToTriplet, towardsContrast, tripletToHex } from '@/services/themeColors'
import {
  nightTheme,
  sanitizeThemePreference,
  themeDefinitions,
  type CustomThemeColors,
  type ThemeId,
  type ThemePreference,
} from '@/plugins/theme'

// Per device, not per account: the theme is already needed on the login
// page, before there is an account to scope it to, and a phone and a
// desktop are often wanted differently.
const STORAGE_KEY = 'beacon.theme'

export function loadThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return sanitizeThemePreference(raw ? JSON.parse(raw) : null)
  } catch {
    return sanitizeThemePreference(null)
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
  appAccent.value = hexToTriplet(definitions[preference.theme]!.colors!.primary as string)
  themeAccent.value = hexToTriplet(definitions[nightTheme(preference)]!.colors!.primary as string)
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
  state: (): ThemePreference => loadThemePreference(),
  getters: {
    /** The theme of the parts that stay dark on a light theme - see
     * plugins/theme.ts's nightTheme(). */
    nightTheme(state): string {
      return nightTheme(state)
    },
  },
  actions: {
    setTheme(theme: ThemeId): void {
      this.theme = theme
      this.persist()
    },

    setCustomColors(colors: Partial<CustomThemeColors>): void {
      const next = sanitizeThemePreference({
        theme: this.theme,
        custom: { ...this.custom, ...colors },
      })
      this.custom = next.custom
      this.persist()
    },

    persist(): void {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ theme: this.theme, custom: this.custom }),
        )
      } catch {
        // Non-critical - the theme just doesn't survive to the next launch.
      }
    },
  },
})
