import type { ThemeDefinition } from 'vuetify'

/** "Beacon" — a light that guides you back into your music. Warm amber
 * signal-light against deep night-navy, not Vuetify's default blue/dark
 * palette. Shared by the app and the party guest page (party/main.ts), so
 * both are the same colours. */
const beacon: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#12141C',
    surface: '#1A1D27',
    'surface-bright': '#232733',
    primary: '#F5A94E',
    secondary: '#5B84B1',
    error: '#E5484D',
    warning: '#F2A93B',
    info: '#5B84B1',
    success: '#5FB489',
  },
}

export const beaconTheme = {
  defaultTheme: 'beacon',
  themes: { beacon },
}
