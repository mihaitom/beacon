import { fetchConnect } from './http'

/** One hit from Radio Browser's own directory (connect/core/radio_browser.py),
 * already trimmed down to what RadioView.vue's discover dialog shows and
 * needs to add a station — see that module's own docstring for the mapping
 * from Radio Browser's raw fields. */
export interface RadioBrowserStation {
  stationuuid: string
  name: string
  url: string
  homepage: string
  favicon: string
  country: string
  state: string
  /** ISO 639-2/B codes, comma-separated (e.g. "en,de") — shown as-is
   * rather than the free-text `language` field, which is not offered at
   * all here (see RadioBrowserFilterOption's own comment). */
  languagecodes: string
  tags: string
  codec: string
  bitrate: number | null
  /** Lifetime total, only ever increases. */
  votes: number
  /** Rolling 24h count, and its change from the day before — a different,
   * more current read on "popular" than `votes`. */
  clickcount: number
  clicktrend: number
  /** Radio Browser's own last health check, majority-voted across its test
   * servers — not verified by this app. */
  lastcheckok: boolean
}

/** One entry in the country filter dropdown — `code` is what
 * SearchRadioBrowserOptions' own `countrycodes` field expects back (see
 * core/radio_browser.py's list_countries() for which raw Radio Browser
 * field it's drawn from).
 *
 * Deliberately no language equivalent — see core/radio_browser.py's own
 * docstring for why a language filter isn't offered at all: Radio
 * Browser's `language` field is free text a station's submitter typed,
 * not a controlled vocabulary the way country is, and /json/languages is
 * mostly noise as a result. */
export interface RadioBrowserFilterOption {
  name: string
  code: string
}

export interface SearchRadioBrowserOptions {
  name?: string
  limit?: number
  /** More than one fans out into its own request per code and merges the
   * results server-side — see core/radio_browser.py's search_stations()
   * for why (Radio Browser's own filter matches only one code at a time). */
  countrycodes?: string[]
  /** "votes" (default) or "clickcount" — see core/radio_browser.py's own
   * _VALID_ORDERS; anything else is normalized to "votes" there too, this
   * is just the two values RadioView.vue's toggle ever actually sends. */
  order?: 'votes' | 'clickcount'
}

/** All fields optional and all default to "no filter" — an empty call is
 * the discover dialog's own initial view (top stations by whichever order
 * is selected, nothing else narrowed down yet), not a degenerate case. */
export async function searchRadioBrowser(
  options: SearchRadioBrowserOptions = {},
): Promise<RadioBrowserStation[]> {
  const { name = '', limit = 30, countrycodes = [], order = 'votes' } = options
  const params = new URLSearchParams({ name, limit: String(limit), order })
  for (const code of countrycodes) params.append('countrycode', code)
  const result = await fetchConnect<{ stations: RadioBrowserStation[] }>(
    `/radio-browser/search?${params.toString()}`,
  )
  return result.stations
}

export async function listRadioBrowserCountries(): Promise<RadioBrowserFilterOption[]> {
  const result = await fetchConnect<{ countries: RadioBrowserFilterOption[] }>(
    '/radio-browser/countries',
  )
  return result.countries
}

/** Reports one listen of `stationuuid` to Radio Browser, whose own
 * popularity ordering is built on that count — the same ordering this
 * app's Discover search offers to sort by.
 *
 * Called from exactly one place, stores/playback.ts's playRadioStation(),
 * whenever a station Beacon knows a Radio Browser id for actually starts
 * playing. Deliberately *not* when a station is added to the library: to
 * the directory a click means somebody listened, and saving a station for
 * later is not listening yet. See services/radioBrowserLinks.ts for how a
 * saved station keeps its id, which is what lets every later play of it be
 * reported rather than only the first encounter.
 *
 * Fire-and-forget — see core/radio_browser.py's register_click() for why a
 * failure here is never worth surfacing to whoever just pressed play. */
export function registerRadioBrowserClick(stationuuid: string): void {
  void fetchConnect(`/radio-browser/click/${encodeURIComponent(stationuuid)}`, {
    method: 'POST',
  }).catch(() => {})
}
