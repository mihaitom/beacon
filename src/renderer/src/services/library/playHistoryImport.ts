import type { PlayHistoryImportStatus } from '@/services/connect/playHistory'

export type ImportSource = 'lastfm' | 'listenbrainz'

export interface ImportOption {
  source: ImportSource
  username: string
}

/** The profiles this account could fill its listening year from. Last.fm
 * also needs the installation's application key. */
export function importOptions(accounts: {
  lastfmName: string
  lastfmConfigured: boolean
  listenbrainzName: string
}): ImportOption[] {
  const options: ImportOption[] = []
  if (accounts.lastfmName && accounts.lastfmConfigured) {
    options.push({ source: 'lastfm', username: accounts.lastfmName })
  }
  if (accounts.listenbrainzName) {
    options.push({ source: 'listenbrainz', username: accounts.listenbrainzName })
  }
  return options
}

export type ImportAction = 'nothing' | 'start' | 'choose' | 'retry'

/** One profile starts by itself. With two, which history is the right one is
 * the listener's call, and they are never mixed: the same plays would count
 * twice. A failed import waits for a button, or a private profile would be
 * asked again on every visit. */
export function importAction(
  status: PlayHistoryImportStatus['status'],
  options: ImportOption[],
): ImportAction {
  if (options.length === 0) return 'nothing'
  if (status === 'failed') return 'retry'
  if (status !== 'none') return 'nothing'
  return options.length === 1 ? 'start' : 'choose'
}
