import { ref } from 'vue'

/** Beacon's amber, the default theme's primary. An "r, g, b" triplet
 * because that is the form the canvas-based consumers (the visualizer, the
 * waveform) need - they cannot read a CSS variable. */
export const DEFAULT_APP_ACCENT = '245, 169, 78'

/** The chosen theme's own accent on its always-dark parts (see
 * plugins/theme.ts's nightTheme()) - what Now Playing falls back to with no
 * colour of its own to borrow. Set by stores/appearance.ts. */
export const themeAccent = ref(DEFAULT_APP_ACCENT)

/** The accent the canvas components draw in. Now Playing borrows the theme's
 * primary for the current track's artwork colour (see NowPlayingView.vue's
 * applyPrimary) and mirrors it here, since a <canvas> needs a concrete value
 * rather than var(--v-theme-primary). */
export const appAccent = ref(DEFAULT_APP_ACCENT)
