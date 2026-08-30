import { defineStore } from 'pinia'

// Mirrors connect/lyrics/__init__.py's LyricSource values exactly — these
// travel as-is in the `sources` query param routes/lyrics.py parses back
// into that same enum (_parse_sources). Brand names, not translated, same
// as "Navidrome"/"Jellyfin"/"Plex" elsewhere in this app.
export const LYRIC_PROVIDERS = ['lrclib.net', 'NetEase', 'SimpMusic'] as const

export type LyricProvider = (typeof LYRIC_PROVIDERS)[number]

const ENABLED_KEY = 'beacon.lyrics-providers'

// Opt-out, same convention as recommendations' enabled-by-default (see
// stores/recommendations.ts's own comment) — Settings has a control for
// anyone who'd rather title/artist/album/duration never go to lrclib.net/
// NetEase/SimpMusic at all (see stores/lyrics.ts's ensureLoaded()), but
// that's the toggle, not the default. Absent (never configured) means
// every provider this build knows about, not an empty list — only an
// *explicit* stored selection (including a deliberately emptied one) is
// taken at face value. A corrupted/foreign value surviving JSON.parse
// (e.g. localStorage shared with a future version that adds a fourth
// provider, or hand-edited storage) is filtered down to only what this
// build actually recognizes rather than trusted outright; if that leaves
// nothing recognizable, it's treated the same as never having configured
// it at all, not as an explicit opt-out.
function loadEnabled(): LyricProvider[] {
  const stored = localStorage.getItem(ENABLED_KEY)
  if (stored === null) return [...LYRIC_PROVIDERS]
  try {
    const raw = JSON.parse(stored) as unknown
    if (!Array.isArray(raw)) return [...LYRIC_PROVIDERS]
    if (raw.length === 0) return [] // an explicit, deliberate opt-out of everything
    const recognized = raw.filter((v): v is LyricProvider =>
      LYRIC_PROVIDERS.includes(v as LyricProvider),
    )
    // Nothing in a non-empty stored array survived recognition (e.g. every
    // entry is from a future/foreign build) — that's not the same as a
    // deliberate empty selection, so fall back to the default rather than
    // silently opting this person out of something they never chose.
    return recognized.length > 0 ? recognized : [...LYRIC_PROVIDERS]
  } catch {
    return [...LYRIC_PROVIDERS]
  }
}

export const useLyricsProvidersStore = defineStore('lyricsProviders', {
  state: () => ({
    enabled: loadEnabled(),
  }),
  actions: {
    setEnabled(value: LyricProvider[]): void {
      this.enabled = value
      try {
        localStorage.setItem(ENABLED_KEY, JSON.stringify(value))
      } catch {
        // Non-critical — worst case the preference doesn't survive to the
        // next launch.
      }
    },
  },
})
