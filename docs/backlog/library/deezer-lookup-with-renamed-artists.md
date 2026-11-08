# Deezer lookups fail or go wrong when an artist was renamed

**Status:** open, deliberately not built. Found 2026-11-08 on the album page's
missing tracks, with one artist so far: the tags say "Ye", Deezer says
"Kanye West". Only worth doing if it turns up with more artists. The approach
below is a recommendation, not a decision.

## What happens

Every Deezer lookup by name compares the artist exactly (folded by `_plain()`
in `connect/core/deezer.py`). For a renamed artist that comparison cannot
succeed. Measured with album "Yeezus" by "Ye":

| Where                                             | Result                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_pick_album()`, the album page's missing tracks  | "Not found". The search is fine: `Ye Yeezus` returns the right album as its first hit, credited to "Kanye West", and the artist check then throws it away |
| `_pick_preview()`, a preview looked up by name    | Read from the code, not run: the same check, so no preview                                                                                                |
| `_find_artist()`, the builder's top tracks, radio | Wrong artist, silently: Deezer has a different artist who really is called "Ye", the exact match wins, and the tracks are theirs                          |

The strict check in `_pick_album()` stays. It is what keeps a different album
from being listed as missing tracks, so anything new only runs once the name
lookup has found nothing.

## Recommended approach

**1. ISRC first.** `GET /track/isrc:USUM71307523` answers with artist
"Kanye West" (id 230) and album "Yeezus"; an unknown code gives the usual
`no data` error, code 800. Take the artist name from that and run the normal
search and `_pick_album()` again under it, so the largest edition is still the
one found. Try the ISRCs of two or three songs, in case Deezer does not know
one of them. A preview can use the same lookup directly.

**2. Tracklist comparison, for albums without ISRCs.** Accept a hit with the
same album title and a different artist only if nearly all of the library's
songs are on it and the durations agree. Titles like "Greatest Hits" are why
the threshold has to be strict; an album with a single song in the library is
excluded.

Stage 1 alone is the smallest useful step.

## What has to be checked or changed for it

- `mapSong()` does not carry the ISRC; today it only arrives with the song
  details (`services/library/songDetails.ts`). Whether Navidrome includes it
  in the `getAlbum` response has not been checked. If not, each album costs a
  few extra song requests.
- `media/jellyfin_bridge.py` and `media/plex_bridge.py` deliver no ISRC, so
  those servers only get stage 2.
- `PrivacyDialog` has to say that the ISRC also goes to Deezer.
- The builder's `_find_artist()` usually has no song and so no ISRC to work
  with. It needs its own answer and is not covered by the above.

## Rejected

- **MusicBrainz aliases.** The data is right ("Ye" has the alias "Kanye West"),
  but it is one more service with a limit of one request per second, and a
  name as short as "Ye" is risky to resolve without an id.
- **A hand-kept alias table.** Never complete, and someone has to maintain it.
- **Fuzzy artist matching.** "Ye" and "Kanye West" are not similar; loosening
  the comparison would only add wrong hits.
