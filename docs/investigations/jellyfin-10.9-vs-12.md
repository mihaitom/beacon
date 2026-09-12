# What a Jellyfin 10.9 server answers differently from a 12 one (2026-09-12)

Beacon's Jellyfin support was rebuilt around v12 on 2026-09-10, when the test
server was upgraded and the inherited Emby auth (`X-Emby-Token`, `api_key`)
started answering 401 on every route. The rebuild was written to serve both
generations - `Authorization: MediaBrowser ... Token="..."` for signing, both
`api_key` and `ApiKey` on the stream URL - but with no 10.x instance left,
"serves both" was an intention, not a measurement.

A 10.9.11 container went up beside the v12 one on 2026-09-12, on the same
media collection, which is what made this checkable. Its library scan was
still running at the time (58%), but all 19933 audio items were already
indexed - the same count v12 reports - so what is measured below is not a
half-filled library. Both servers are reachable at the same time, so the live
suite can be pointed at either:

```bash
JELLYFIN_TEST_URL=http://<host>:<10.9 port> JELLYFIN_TEST_TOKEN=... \
JELLYFIN_TEST_USER_ID=... uv run pytest -m live -k jellyfin
```

## Result: 10.9 is supported, with one narrow gap

The live Jellyfin suite passes against 10.9.11 - login, browsing, favourites,
playlists including reorder and multi-position removal, cover art, ranged
streaming, the bridge-free stream URL, scan status and admin rights. Every
route Beacon calls exists in 10.9's own OpenAPI document, including the two
that replaced the user-scoped forms v12 dropped (`/Items?userId=` and
`/UserFavoriteItems/{id}`) - they are what puts the lower bound at 10.9 rather
than 10.8.

Signing with `Authorization: MediaBrowser ... Token="..."` works on both
generations, so the one header covers everything. Nothing had to change in the
bridge for 10.9.

### The gap: lyrics out of the media file, but sidecars are fine

10.9 does not read lyrics out of the media file. Tracks whose tags carry
lyrics report `HasLyrics: false` and answer `/Audio/{id}/Lyrics` with a 404,
verified against files `ffprobe` shows an ID3 `lyrics` tag on; none of 3000
sampled tracks reported `HasLyrics` at all. That arrived in 10.10.

The clean half of that measurement: both servers index the same collection,
and a Jellyfin item id is derived from the file path, so the *same* id can be
asked of both. One track that v12 reports `HasLyrics: true` for answers with a
full lyric sheet there and 404 on 10.9 - same id, same file, different
generation.

A **sidecar `.lrc` is read by both**, with the same timings and the same shape
the bridge already parses. That had to be set up to be measurable: the
collection's only `.lrc` had been orphaned by an MP3-to-FLAC upgrade on
2026-09-11 (it stayed in the old directory, which no longer holds an audio
file), and Jellyfin only looks beside the media file itself. Copied next to
the FLAC, it works on 10.9.11 and on 12.0.0.

Two things learned while doing that, both of which will cost someone an hour
otherwise:

- **A new sidecar is not picked up on the next request.** Both servers
  answered 404 for it until the item was refreshed
  (`POST /Items/{id}/Refresh?metadataRefreshMode=FullRefresh`) - the lyric
  lives in the item's metadata, not in a per-request lookup of the directory.
- **10.9 fills the `Metadata` block from the `.lrc` header** (`Artist`,
  `Album`, `Title`), where v12 sends `{}`. It changes nothing here, because
  the bridge derives `synced` from whether the lines carry timings rather than
  from anything the server says about them - which is what the 2026-08-27
  lyrics work concluded, and this is the second server generation to justify
  it.

The embedded-tag gap costs nothing structurally: the bridge turns the 404 into
an empty `lyricsList`, the same answer as "this song has no lyrics", and the
app falls through to lrclib. On a 10.9 server without sidecars that fallback
is the only source.

Which track `JELLYFIN_TEST_LYRICS_ITEM_ID` names therefore decides what the
lyrics live test covers, and the two sources are not equivalent: the trailing
NUL byte the test guards against only appears on a lyric read out of a tag. So
point it at a tagged track on a server that can read one (v12 can; the id is
the same on both servers, being path-derived) and fall back to the sidecar
track only on 10.9, where a tag is never read.

### Playlists holding one song twice

The two generations differ here in both directions, and neither can edit such
a playlist copy by copy - see
[playlist-duplicate-entries.md](playlist-duplicate-entries.md), which has the
measurements per generation.

## Ruled out as a difference

- **Not the auth header.** The `MediaBrowser ... Token` form is accepted by
  10.9.11 on every route Beacon uses, so the v12 rebuild did not trade one
  generation for the other.
- **Not the stream URL.** The URL the app plays without going through the
  bridge works on 10.9 as it does on v12; carrying both `api_key` and
  `ApiKey` is what makes that true, and dropping either would only show up on
  one generation.
- **Not cover art.** A cover art test did fail first against the fresh 10.9
  library, but on its own naivety: it took the first album of the listing,
  and on that server the alphabetically first album has no picture. Both
  bridges always fill Subsonic's `coverArt` and only attach an artwork
  version when artwork exists, so the field alone never said "there is a
  picture". The test now picks an album whose cover art id carries a version.
