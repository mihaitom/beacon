/** Rebuilds the full radio station behind what connect reports playing.
 * Lifted out of stores/playback.ts because it reads only the library
 * store, never playback state - the store's reconcileFromStatus() is its
 * one caller.
 *
 * The module-level fetch flag below is why this is a module rather than a
 * plain function: it has to survive across calls for the whole session. */

import { useLibraryStore } from '@/stores/library'
import type { RadioStation } from '@/types/library'

// Whether resolveRadioStation() has already paid for a station-list fetch
// this session. Only ever set when the list was empty and a lookup missed,
// so a station connect reports that genuinely isn't in the library (an
// ad-hoc URL, another client's station) can't turn every status tick into
// a request.
let radioStationsFetched = false

/** The full station behind what connect reports playing. The status
 * itself carries only a title and a stream URL (see ConnectStatus's
 * `radio`), which is everything the player *bar* needs but not enough
 * for its logo: that is looked up from the station's own homepage (see
 * radioFaviconUrl), and a station rebuilt without one shows the
 * generic radio icon in the player bar and Now Playing for as long as
 * it keeps playing. Matched against the library's own station list
 * instead — by stream URL, then by name, since connect may report the
 * URL it actually ended up streaming from rather than the one the
 * station is stored with.
 *
 * Falls back to the bare title/URL pair for a station that genuinely
 * isn't in the library, which is the same station this used to build
 * unconditionally. */
export async function resolveRadioStation(streamUrl: string, title: string): Promise<RadioStation> {
  const library = useLibraryStore()
  const findKnown = (): RadioStation | undefined =>
    library.radioStations.find((station) => station.streamUrl === streamUrl) ??
    library.radioStations.find((station) => station.name === title)

  let known = findKnown()
  if (!known && !library.radioStations.length && !radioStationsFetched) {
    // Nothing to match against yet — the list is only loaded when
    // RadioView is opened, and a session that started casting radio
    // from another client may never have opened it.
    radioStationsFetched = true
    try {
      await library.fetchRadioStations()
    } catch (error) {
      console.error('[playback] Failed to load radio stations:', error)
    }
    known = findKnown()
  }
  // The reported URL wins over the stored one even on a match: it is
  // what is actually playing, and it is what the next status tick is
  // compared against — keeping the stored URL instead would make every
  // single tick look like a station change and rebuild this (clearing
  // the queue with it) over and over.
  return known ? { ...known, streamUrl } : { id: '', name: title, streamUrl, homePageUrl: null }
}
