import { ref } from 'vue'

/** The app's amber: the theme's primary, and what every accent-coloured
 * thing falls back to. An "r, g, b" triplet because that is the form the
 * canvas-based consumers (the visualizer, the waveform) need - they cannot
 * read a CSS variable. */
export const DEFAULT_APP_ACCENT = '245, 169, 78'

/** The accent the canvas components draw in. Now Playing borrows the theme's
 * primary for the current track's artwork colour (see NowPlayingView.vue's
 * applyPrimary) and mirrors it here, since a <canvas> needs a concrete value
 * rather than var(--v-theme-primary). */
export const appAccent = ref(DEFAULT_APP_ACCENT)
