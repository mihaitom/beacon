---
order: 4
---

# What the library shows

## Why does the path column show a path that does not exist on disk?

Because that is what the server sent. Navidrome hands Subsonic clients a synthesised path, in the shape `Artist/Album/01-03 - Title.mp3`, rather than the real one, unless "Report Real Path" is switched on for that player in Navidrome's own settings. Beacon shows the value it was given rather than guessing at a nicer one.

## I removed one of two identical tracks from a playlist and both disappeared

On a Jellyfin 12 server the two copies are indistinguishable: it reports the same id for both entries, so a removal names both. Jellyfin's own web client does exactly the same thing on the same playlist, which is what puts this in the server rather than in Beacon. Reordering such a playlist is unreliable there for the same reason.

It cannot happen anywhere else. Jellyfin 10.9 and Plex will not hold the same song twice in the first place - adding a song a playlist already has answers success and changes nothing - and Navidrome removes exactly the copy that was clicked. Measured against real servers on 2026-09-12; [investigations/playlist-duplicate-entries.md](../../investigations/playlist-duplicate-entries.md) has the payloads, and the two fixes that were weighed and not taken.

## Why does Beacon ask for my Navidrome password to edit a smart playlist?

Because Navidrome keeps a smart playlist's rules only in its own API, not in the Subsonic one Beacon uses for everything else, and that API logs in with a password rather than with the token Beacon signed in with. Beacon sends the password it stored at sign-in to its own backend once per session; the backend logs into Navidrome with it, keeps only the session token Navidrome hands back, and uses that token for the playlist endpoints and nothing else. Only when no password is stored (a login taken over from Remote Control, say) or Navidrome no longer accepts it does the editor ask.

## Why are the rules of some smart playlists read-only?

They come from an `.nsp` file in your library. Navidrome reads that file again at the next library scan and would overwrite whatever was changed in Beacon, so the editor shows those rules without letting them be changed. Edit the file instead.
