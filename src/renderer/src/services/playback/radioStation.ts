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
 * `previous` is whatever this client already had for the station that was
 * playing right before this call — reconcileFromStatus()'s own
 * this.radioStation, from the moment before it's overwritten with this
 * function's result. A station played straight out of RadioView.vue's
 * discover dialog (playBrowsedStation()) is deliberately never saved (see
 * that function's own comment), so it can never match the library lookup
 * above — and connect routinely reports back a stream URL that differs
 * from the one that was dispatched (a redirect followed, or a .m3u/.pls
 * playlist resolved to the address inside it — see routes/radio.py), which
 * is exactly the condition that makes reconcileFromStatus() call this in
 * the first place. Without `previous`, that "same station, different final
 * URL" case looked identical to a genuine station change and lost the
 * artwork (and any other Radio Browser-only fields) it was dispatched
 * with, on essentially every browsed-station play, not some edge case —
 * reported live 2026-09-01. Matched by name, the one field that survives a
 * resolved URL and is still meaningful for an unsaved station (it has no
 * id to compare instead). */
export async function resolveRadioStation(
  streamUrl: string,
  title: string,
  previous: RadioStation | null,
): Promise<RadioStation> {
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
  if (known) return { ...known, streamUrl }
  if (previous?.name === title) return { ...previous, streamUrl }
  return { id: '', name: title, streamUrl, homePageUrl: null }
}
