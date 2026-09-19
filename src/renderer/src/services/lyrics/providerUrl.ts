/** Each provider's own web page for one lyric sheet, keyed by the source
 * name connect reports (connect/lyrics/__init__.py's LyricSource). The id
 * is whatever that provider answered the search with: lrclib's own track
 * id, NetEase's song id, and for SimpMusic the YouTube video id its
 * database is keyed by. */
const PAGE_URLS: Record<string, (id: string) => string> = {
  'lrclib.net': (id) => `https://lrclib.net/tracks/${encodeURIComponent(id)}`,
  NetEase: (id) => `https://music.163.com/#/song?id=${encodeURIComponent(id)}`,
  SimpMusic: (id) => `https://lyrics.simpmusic.org/#/video/${encodeURIComponent(id)}`,
}

/** Where to look at the shown lyrics at their source, so a sheet that is
 * wrong can be checked (and corrected) there. Null for the file's own
 * lyrics, and for an entry cached before the provider's id was kept. */
export function lyricsPageUrl(source: string | null, remoteId: string | null): string | null {
  if (!source || !remoteId) return null
  return PAGE_URLS[source]?.(remoteId) ?? null
}
