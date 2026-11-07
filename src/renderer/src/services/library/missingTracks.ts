/** Which tracks of an album the library does not hold, against the largest
 * Deezer edition of it (connect/core/deezer.py's get_album()). */

import { normalize } from '@/services/stringMatch'
import type { DeezerAlbumTrack } from '@/services/connect/deezer'
import type { Song } from '@/types/library'

/** An album held against its Deezer edition (compareWithEdition()). */
export interface EditionComparison {
  missing: MissingTrack[]
  /** Each song's number on the edition, by song id, for the songs that are
   * on it - so the album's numbering runs through the missing ones too. */
  trackNumbers: Record<string, number>
}

export interface MissingTrack {
  track: DeezerAlbumTrack
  /** How many of the album's songs, in their given order, come before it -
   * where the album page draws it. */
  position: number
}

/** A title without its version and its guests: "Touch (2021 Epilogue)
 * [feat. Paul Williams]" and "Touch (feat. Paul Williams)" are one song. */
function baseTitle(title: string): string {
  return normalize(
    title
      .replace(/\([^()]*\)|\[[^[\]]*\]/g, ' ')
      .replace(/\s(?:feat|ft|featuring)\.?\s.*$/i, ' ')
      .replace(/\s-\s.*$/, ' '),
  )
}

// Tried in this order, each on what the ones before left unmatched, so a
// stricter reading always claims a song first: "Blank Space" is the album's
// "Blank Space", never its "Blank Space (Voice Memo)", which Deezer's short
// title would also call "Blank Space".
const TIERS: [(song: Song) => string, (track: DeezerAlbumTrack) => string][] = [
  [(song) => normalize(song.title), (track) => normalize(track.title)],
  [(song) => normalize(song.title), (track) => normalize(track.titleShort)],
  [(song) => baseTitle(song.title), (track) => baseTitle(track.title)],
]

/** The Deezer tracks no song of `songs` is, each placed after the song
 * that holds the track before it on Deezer's tracklist, and the edition's
 * number of every song that is on it. A song matches one track at most, so
 * an album holding a song once still misses its second version. */
export function compareWithEdition(
  songs: readonly Song[],
  tracks: readonly DeezerAlbumTrack[],
): EditionComparison {
  const songFor = new Map<number, number>()
  const claimed = new Set<number>()
  for (const [libraryKey, deezerKey] of TIERS) {
    tracks.forEach((track, t) => {
      if (songFor.has(t)) return
      const key = deezerKey(track)
      if (!key) return
      const s = songs.findIndex((song, i) => !claimed.has(i) && libraryKey(song) === key)
      if (s < 0) return
      songFor.set(t, s)
      claimed.add(s)
    })
  }

  const missing: MissingTrack[] = []
  const trackNumbers: Record<string, number> = {}
  let position = 0
  tracks.forEach((track, t) => {
    const s = songFor.get(t)
    if (s === undefined) {
      missing.push({ track, position })
      return
    }
    position = s + 1
    if (track.trackNumber) trackNumbers[songs[s]!.id] = track.trackNumber
  })
  return { missing, trackNumbers }
}
