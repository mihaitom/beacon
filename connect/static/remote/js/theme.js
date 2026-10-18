// theme.js — the Remote Control in the colours of the app it controls. The
// desktop sends its theme's palette with every snapshot (the renderer's
// plugins/theme.ts remotePalette()); this puts it into app.css's variables.
// Remembered on the phone, so a reload starts in the right colours instead
// of flashing app.css's Beacon defaults until the first snapshot arrives.

const STORAGE_KEY = 'beacon_remote_theme';

// Palette key -> app.css variable.
const VARIABLES = {
  background: '--bg',
  chrome: '--chrome',
  surface: '--surface',
  surface_bright: '--surface-2',
  text: '--text',
  text_muted: '--text-muted',
  accent: '--accent',
  accent_on: '--accent-on',
  error: '--error',
  warning: '--warning',
  success: '--success',
};

const HEX_RE = /^#[0-9a-f]{6}$/i;

let applied = null;

function triplet(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** Applies a palette; anything that isn't one (an older desktop that sends
 * none, a malformed value) leaves the current colours alone. */
export function applyTheme(palette) {
  if (!palette || typeof palette !== 'object') return;
  const key = JSON.stringify(palette);
  // Every snapshot carries it, several times a second while playing.
  if (key === applied) return;
  if (!Object.keys(VARIABLES).every((name) => HEX_RE.test(palette[name] ?? ''))) return;
  const root = document.documentElement;
  for (const [name, variable] of Object.entries(VARIABLES)) {
    root.style.setProperty(variable, palette[name]);
  }
  // The rgba() tints in app.css (borders, hover, glows) and the waveform's
  // canvas need the two as triplets.
  root.style.setProperty('--accent-rgb', triplet(palette.accent));
  root.style.setProperty('--text-rgb', triplet(palette.text));
  root.style.colorScheme = palette.dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.chrome);
  applied = key;
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Private mode: the next reload just starts in the defaults again.
  }
}

/** The palette from last time, before anything has been received. */
export function restoreTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) applyTheme(JSON.parse(stored));
  } catch {
    // Unreadable: app.css's defaults it is.
  }
}
