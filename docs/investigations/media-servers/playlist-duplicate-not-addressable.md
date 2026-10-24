# Neither bridge can address one copy of a song listed twice (OPEN 2026-09-12)

Measured 2026-09-12, when "remove from playlist" was first run against real
servers - the Jellyfin half against both 10.9.11 and 12.0.0, which answer
differently. Every finding here is server behaviour, not a bridge bug, and the
two that Beacon can run into are recorded as `xfail(strict=True)` in
`connect/tests/test_bridges_live.py` so they turn red on their own if a server
ever changes its mind.

**A playlist that holds the same song twice cannot be edited copy by copy on
Jellyfin 12, and cannot be built at all on Plex or on Jellyfin 10.9.**
Navidrome does both correctly and is unaffected.

## Jellyfin 12.0.0: `PlaylistItemId` is the item's own `Id`

`_playlist_entries()` reads `PlaylistItemId` per entry on the premise that it
is a per-entry handle distinct from the song id - that premise is what makes
"remove position 3" resolvable at all. On the v12 test server the two fields
are the same value:

    Server-Version: 12.0.0
    Id:             6529707962bc067ebf8c1132504f5f53
    PlaylistItemId: 6529707962bc067ebf8c1132504f5f53

Dumping every field of a playlist item whose name contains `Id` turns up no
other per-entry candidate (`ServerId`, `Id`, `PlaylistItemId`, `ChannelId`,
`AlbumId`). So the two copies are indistinguishable, and
`DELETE /Playlists/{id}/Items?EntryIds=<id>` takes both:

    playlist  [A, B, C, A]  ->  remove position 3  ->  [B, C]

The bridge cannot address one copy: there is nothing in the payload that
names one rather than the other. This is a regression rather than how Jellyfin
has always answered - 10.9.11 hands out a real per-entry GUID here (see the
next section), so the field changed between the two generations, which is what
makes it worth reporting upstream.

**Jellyfin's own web client cannot do it either**, confirmed by hand in the
v12 UI on 2026-09-12: removing one of two copies there takes both, exactly as
through the bridge. That rules out the translation in `_remove_from_playlist()`
as the cause and puts it squarely in the server - which is the version of this
worth filing upstream, since it needs no mention of Beacon at all.

**What it means beyond removal:** `_set_playlist_songs()` builds `keep`,
`stale`, `current` and `target` out of entry ids and hands them to
`reorder_moves()`, which does `working.remove(entry_id)` and
`working.index(follower)`. All of that assumes entry ids are unique.
Reordering a Jellyfin v12 playlist that holds a duplicate is therefore
unreliable too, for the same root cause - not just removing from one.

## Jellyfin 10.9.11: the entry id is distinct, but no duplicate can exist

A 10.9.11 server went up alongside the v12 one on 2026-09-12, which is what
made the two generations comparable. There `PlaylistItemId` is what the bridge
assumes - a per-entry GUID, nothing like the song id:

    Server-Version: 10.9.11
    Id:             c8aa000020fbb890505b20776694140d
    PlaylistItemId: eeb620418b6e41d5bc524aba322693ea

It buys nothing, because 10.9 will not hold the same song twice in the first
place. Both ways in collapse the duplicate and answer success:

    POST /Playlists          Ids=[a, b, c, a]   ->  3 entries
    POST /Playlists/{id}/Items?ids=a            ->  204, playlist unchanged

So the end state matches Plex rather than v12: "add to playlist" for a song
already in it does nothing, and an undo cannot restore a second copy. The
removal-by-position path itself is unambiguous on 10.9 and works.

A playlist that *did* hold a duplicate - written by v12, or by something
else against the same database - would be editable copy by copy on 10.9,
since its entry ids differ. Not worth building for: the app cannot produce
that state through 10.9.

## Plex: `songIdToAdd` silently drops a song already in the playlist

    PUT /playlists/{id}/items?uri=server://<machine>/.../metadata/<ratingKey>

answers ok and adds nothing when the playlist already holds that ratingKey.
Measured by adding an existing id to a three-track playlist and re-listing it:
still three entries.

Two consequences. "Add to playlist" for a song already in it does nothing on
Plex and always has - that predates this investigation and is not new. And
the undo behind a removal cannot restore a second copy: `_set_playlist_songs()`
computes the missing ids, `_add_to_playlist()` sends them, Plex ignores the
duplicate, the following `match_entries_to_song_ids()` leaves that slot `None`,
and the entry is skipped rather than failing the call. The playlist comes back
one copy short, with a 200.

## What was checked and is fine

- **Undo on a playlist without duplicates works on both bridges**, contents
  and order. Driven by hand through `create_playlist(playlistId=..., songId=[...])`
  - remove the middle track, send the complete original list back, re-list:
  identical to the start on Jellyfin and on Plex. This is the path
  `restorePlaylistSongs()` uses and nothing else exercised it before.
- **Multi-position removal** resolves every position against one listing
  before deleting anything, on both bridges, so the order the positions
  arrive in does not matter. Verified live in both directions.
- **Navidrome** handles a duplicate correctly: removing position 6 of
  `[A, B, C, D, E, F, A]` leaves the copy at position 0 alone.
- **Emptying a playlist leaves it standing** on all three. Removing every
  entry (and the one-entry case, which is the same thing) keeps the playlist
  in `getPlaylists` and answers `getPlaylist` with no entries, so the undo
  has something to restore into. Navidrome leaves `entry` out of the
  response altogether where Jellyfin and Plex send an empty list - which
  `mapPlaylist()` already reads as `raw.entry ?? []`. Worth asking of Plex
  in particular, whose creation endpoint cannot make an empty playlist in
  the first place. Covered by `..._keeps_a_playlist_that_loses_its_last_entry`
  per backend.

## Ruled out

- **Not the app's index translation.** `SongTable.onRemoveRequested()`
  resolves rows by object identity, not by song id, so it sends the position
  of the copy that was actually clicked. Checked by mutation: swapping
  `indexOf(track)` for a lookup by `song.id` turns the duplicate test in
  `SongTable.remove.test.ts` red immediately.
- **Not the descending order the app sends positions in.** Both bridges read
  the playlist once and map every position before issuing a delete, so
  ascending produces the same result; the live tests assert both orders.
- **Not a stale listing.** The delete follows its listing within the same
  handler call, and the probe above re-listed between every step.

## Left open

Accepted as it stands on 2026-09-12: a playlist holding the same song twice is
rare enough not to be worth what either fix costs. Nothing in the app warns
about it. The two fixes that were weighed, so the next round starts here
rather than at the beginning:

**Refuse the ambiguous removal.** The bridge can see that the entry ids it
just read are not unique, and fail instead of deleting. Three lines, no risk,
and it puts the app on its existing error path (re-read, notice, no undo
offer) instead of quietly deleting more than was asked. The cost is that the
feature simply does not work on such a playlist.

**Rebuild the list.** Since no single copy can be addressed, the only
expressible fix is to replace the whole thing: delete every entry, re-add the
survivors in order. Gated to the ambiguous case it would leave every ordinary
removal untouched (on Navidrome and Plex the entry ids are unique, so the
condition is never true there), and it would fix reordering with duplicates
along with it.

It was not taken because **it is not atomic and its failure mode is worse than
the bug**. Today's worst case is one extra copy of the same song disappearing;
a rebuild that breaks between the delete and the re-add leaves the playlist
empty, and there is no transaction to lean on. That the client holds the
complete list and offers an undo only helps if somebody presses it. A long
playlist also pays for it twice over: removing one track rewrites every entry,
and each entry is new afterwards (its "date added" is lost).

The three measurements a rebuild needs were taken on 2026-09-12, against both
generations, so that part is no longer in the way:

| | 10.9.11 | 12.0.0 |
| --- | --- | --- |
| `ids=a,b,a` in one add | collapses to one `a` | two entries for `a` |
| order of a multi-id add | preserved | preserved |
| DELETE naming every entry id | empties it, playlist stands | empties it, playlist stands |

A rebuild is therefore expressible on v12: the survivors can be re-added in
one call, in order, and the playlist can be emptied first. What stopped it is
unchanged - it is still not atomic, and it still costs every entry's "date
added".

One wart to know about: the two `xfail(strict=True)` cases below turn *any*
failure into an expected one, so they stay quiet when the reason is an
unreachable or re-authenticating server rather than the duplicate handling
(which is how the v12 401s were missed for a while on 2026-09-12). The rest of
the Jellyfin live tests go red loudly, and that is what actually says the
server is the problem.
