/** Shared playback vocabulary — the small domain types that both
 * stores/playback.ts and the helpers in this directory need. Kept here
 * rather than in the store so a helper can name them without importing the
 * store back (see persistence.ts, which describes a snapshot of exactly
 * these). Mirrors services/connect/types.ts and services/subsonic/types.ts. */

/** What happens when the queue runs out: nothing, start over, or keep
 * repeating the current song. */
export type RepeatMode = 'off' | 'all' | 'one'
