import type { ThemeDefinition } from 'vuetify'
import { contrast, isDarkColor, isHexColor, mix, towardsContrast } from '@/services/themeColors'

/** "Beacon" — a light that guides you back into your music. Warm amber
 * signal-light against deep night-navy, not Vuetify's default blue/dark
 * palette. The default, and the only theme of the party guest page
 * (party/main.ts), whose guests have no settings to pick another from.
 *
 * `chrome` is the always-visible frame (nav rail, app bar, player bar): one
 * shade darker than the content on a dark theme, like dark water behind a
 * lit surface, and one shade deeper than the page on a light one. */
const beacon: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#12141C',
    surface: '#1A1D27',
    'surface-bright': '#232733',
    chrome: '#0B0D13',
    primary: '#F5A94E',
    secondary: '#5B84B1',
    error: '#E5484D',
    warning: '#F2A93B',
    info: '#5B84B1',
    success: '#5FB489',
  },
}

const graphite: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#151515',
    surface: '#1E1E1F',
    'surface-bright': '#2A2A2C',
    chrome: '#0E0E0E',
    primary: '#4FD1C5',
    secondary: '#8A9BB0',
    error: '#F0595E',
    warning: '#F2A93B',
    info: '#8A9BB0',
    success: '#6CC490',
  },
}

/** The states on a light page: the dark themes' own hues are too pale to
 * read on white, so these are the same colours a few steps deeper. */
const LIGHT_STATES = {
  error: '#C42B30',
  warning: '#A65F00',
  success: '#2E8456',
}

// On a light page the amber reaches barely 2:1 against white, so Paper's
// accent is the same hue as copper, at 5.4:1.
const paper: ThemeDefinition = {
  dark: false,
  colors: {
    background: '#F6F2EA',
    surface: '#FFFFFF',
    'surface-bright': '#EFE8DC',
    chrome: '#EAE2D4',
    primary: '#9E5800',
    secondary: '#4F6F94',
    info: '#4F6F94',
    'on-background': '#24201A',
    'on-surface': '#24201A',
    ...LIGHT_STATES,
  },
}

const mist: ThemeDefinition = {
  dark: false,
  colors: {
    background: '#EEF1F5',
    surface: '#FFFFFF',
    'surface-bright': '#E3E8EF',
    chrome: '#E1E6ED',
    primary: '#2E6BB0',
    secondary: '#6B7A8F',
    info: '#2E6BB0',
    'on-background': '#1A1F27',
    'on-surface': '#1A1F27',
    ...LIGHT_STATES,
  },
}

/** Beacon's night with another accent: what a light theme's always-dark
 * parts are drawn in (see `nightTheme`). */
function night(primary: string): ThemeDefinition {
  return { dark: true, colors: { ...beacon.colors, primary } }
}

export type ThemeDefinitionColors = NonNullable<ThemeDefinition['colors']>

export type ThemeId = 'beacon' | 'graphite' | 'paper' | 'mist' | 'custom'

/** What a self-made theme is chosen from. Everything else is derived. */
export interface CustomThemeColors {
  background: string
  primary: string
}

export const DEFAULT_CUSTOM_COLORS: CustomThemeColors = {
  background: '#1B1F24',
  primary: '#E07A5F',
}

export interface ThemePreference {
  theme: ThemeId
  custom: CustomThemeColors
}

export const DEFAULT_THEME_PREFERENCE: ThemePreference = {
  theme: 'beacon',
  custom: DEFAULT_CUSTOM_COLORS,
}

/** The presets in the order Settings lists them, dark ones first. */
export const PRESET_THEMES: { id: Exclude<ThemeId, 'custom'>; definition: ThemeDefinition }[] = [
  { id: 'beacon', definition: beacon },
  { id: 'graphite', definition: graphite },
  { id: 'paper', definition: paper },
  { id: 'mist', definition: mist },
]

/** The accent an accent has to become on the dark parts: the copper and
 * blue of the light themes are too dark to read there. */
const NIGHT_ACCENT_CONTRAST = 4.5

/** A full theme from a background and an accent. The surfaces are steps of
 * the background towards the text colour, the frame a step away from it,
 * the same distances the presets keep. */
export function customTheme({ background, primary }: CustomThemeColors): ThemeDefinition {
  const dark = isDarkColor(background)
  if (dark) {
    return {
      dark: true,
      colors: {
        ...beacon.colors,
        background,
        surface: mix(background, '#FFFFFF', 0.04),
        'surface-bright': mix(background, '#FFFFFF', 0.09),
        chrome: mix(background, '#000000', 0.35),
        primary,
      },
    }
  }
  return {
    dark: false,
    colors: {
      ...paper.colors,
      background,
      surface: mix(background, '#FFFFFF', 0.7),
      'surface-bright': mix(background, '#000000', 0.04),
      chrome: mix(background, '#000000', 0.06),
      primary,
      'on-background': mix(background, '#000000', 0.88),
      'on-surface': mix(background, '#000000', 0.88),
    },
  }
}

function definitionOf(preference: ThemePreference): ThemeDefinition {
  if (preference.theme === 'custom') return customTheme(preference.custom)
  return PRESET_THEMES.find((preset) => preset.id === preference.theme)!.definition
}

/** The Vuetify theme for the always-dark parts of the app - the artwork
 * headers, Now Playing - which lay white text over a darkened picture and
 * stay that way on a light theme. A dark theme is its own. */
export function nightTheme(preference: ThemePreference): string {
  return definitionOf(preference).dark ? preference.theme : `${preference.theme}-night`
}

/** Every theme Vuetify needs to know about for this preference, the chosen
 * one and the night one of each light theme. */
export function themeDefinitions(preference: ThemePreference): Record<string, ThemeDefinition> {
  const themes: Record<string, ThemeDefinition> = {}
  // Copies: Vuetify keeps what it is handed and Now Playing writes its
  // borrowed accent into it (see stores/appearance.ts's borrowAccent()),
  // which would otherwise overwrite the very colours it restores from.
  for (const { id, definition } of PRESET_THEMES) {
    themes[id] = { ...definition, colors: { ...definition.colors } }
  }
  themes.custom = customTheme(preference.custom)
  for (const [id, definition] of Object.entries({ ...themes })) {
    if (definition.dark) continue
    const accent = towardsContrast(
      definition.colors!.primary as string,
      beacon.colors!.background as string,
      NIGHT_ACCENT_CONTRAST,
    )
    themes[`${id}-night`] = night(accent)
  }
  return themes
}

/** A stored preference, cleaned of anything this build does not know -
 * an unknown theme or a colour that isn't one falls back to the default. */
export function sanitizeThemePreference(raw: unknown): ThemePreference {
  const value = (raw ?? {}) as Partial<ThemePreference>
  const known: ThemeId[] = [...PRESET_THEMES.map((preset) => preset.id), 'custom']
  const custom = (value.custom ?? {}) as Partial<CustomThemeColors>
  return {
    theme: known.includes(value.theme as ThemeId) ? (value.theme as ThemeId) : 'beacon',
    custom: {
      background: isHexColor(custom.background)
        ? custom.background.toUpperCase()
        : DEFAULT_CUSTOM_COLORS.background,
      primary: isHexColor(custom.primary)
        ? custom.primary.toUpperCase()
        : DEFAULT_CUSTOM_COLORS.primary,
    },
  }
}

/** Vuetify's theme options for a preference - read before the app mounts,
 * so the first frame is already in the chosen theme. */
export function themeOptions(preference: ThemePreference) {
  return { defaultTheme: preference.theme, themes: themeDefinitions(preference) }
}

/** What the Remote Control draws in: the chosen theme's own colours (never
 * Now Playing's borrowed accent), as concrete values, since the phone's
 * plain-JS page has no Vuetify to derive them. Sent with every snapshot
 * (stores/remoteControl.ts) and applied by connect/static/remote/js/theme.js. */
export interface RemotePalette {
  dark: boolean
  background: string
  chrome: string
  surface: string
  surface_bright: string
  text: string
  text_muted: string
  accent: string
  accent_on: string
  error: string
  warning: string
  success: string
}

// The Remote's own text white on a dark theme, a hair off pure white.
const REMOTE_DARK_TEXT = '#F2F2F4'
// How far the muted text sits towards the background: the Remote's
// #9A9AA2 on Beacon's navy.
const MUTED_TEXT_MIX = 0.42

export function remotePalette(preference: ThemePreference): RemotePalette {
  const definition = themeDefinitions(preference)[preference.theme]!
  const colors = definition.colors as Record<string, string>
  const dark = Boolean(definition.dark)
  const background = colors.background!
  const text = dark ? REMOTE_DARK_TEXT : colors['on-surface']!
  const accent = colors.primary!
  return {
    dark,
    background,
    chrome: colors.chrome!,
    surface: colors.surface!,
    surface_bright: colors['surface-bright']!,
    text,
    text_muted: mix(text, background, MUTED_TEXT_MIX),
    accent,
    // White where it reads on the accent, else the darkest the theme has -
    // what Vuetify's own on-primary does on the app's buttons.
    accent_on: contrast(accent, '#FFFFFF') >= 4.5 ? '#FFFFFF' : dark ? background : '#000000',
    error: colors.error!,
    warning: colors.warning!,
    success: colors.success!,
  }
}

/** The party guest page: Beacon only. */
export const beaconTheme = { defaultTheme: 'beacon', themes: { beacon } }
