# Remote: an album detail view, as the phone got with the 2026-09-13 release

**Status:** open. After this the Remote Control is done - bringing it further
in line with the mobile view is explicitly not planned (as of 2026-09-13).

In the Remote an album opens nothing - `js/album-row.js` plays it right away
on a tap (`fireCommand('play-album', { albumId })`), and there is no detail
view. The web/desktop mobile view has exactly that since that cycle: a tap
opens the album with its tracks in album order and a button to play them
all, while the play button on the row still starts it at once. Build the
same in the Remote; the template is its existing playlist detail view.

## Four places, none of them much work

The value of this entry is that none gets forgotten:

- **Renderer:** an `album-request` in
  `src/renderer/src/services/remoteControl/commands.ts`, practically a copy
  of the `playlist-request` next to it. `library.fetchAlbum(id)` exists,
  `play-album` uses it in the same file.
- **Backend:** `/remote/albums/{album_id}` in `connect/routes/remote.py`,
  after `/remote/playlists/{playlist_id}` - one `_query("album-request", ...)`
  line.
- **Remote:** `fetchAlbum(id)` in `js/api.js`, the view itself and a
  `registerRoute('/albums/:id', ...)`.
- **Do not forget `sw.js`.** Every new file under `js/views/` has to go into
  the service worker's `SHELL_PATHS`, or it drops out of the precache and the
  installed app loads a shell missing a view.

## Two things that will come up

- **`play-album` has no `startIndex`.** Its handler in `commands.ts` passes a
  hard `0` to `playSongList()`, unlike `play-playlist` right below it, which
  reads `payload.startIndex`. Tapping a track in the album view needs that
  first. Keep `pinFirst` at `false` - that is the deliberate album order, the
  comment there says why.
- **A tap then opens instead of playing.** The same switch as on the phone.
  `album-row.js` has no play button of its own yet, only the clickable row -
  one has to be added, or playing at once is lost altogether. The comment at
  the top of `album-row.js` explains today's state (no action sheet, because
  there are no album actions on the desktop side) and has to change with it.
