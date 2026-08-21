# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added Autoplay - once the queue is down to its last song or so, similar songs get added automatically so playback never just runs dry. Off by default; toggle it from the icon next to Queue in the player bar, and set how many songs get added per top-up in Settings. Works the same for local playback and casting, and keeps topping the queue up on its own server-side even if nothing's around to do it locally (e.g. a phone's screen is locked)
- Added Song Radio, Artist Radio, and Autoplay support for Plex (needs an active Plex Pass on the account) - previously Navidrome/Subsonic and Jellyfin only
- Added OS media key support - play/pause/previous/next now work from the keyboard's media keys, the lock screen on Windows/macOS, and the media widget on GNOME/KDE, showing the current song's title/artist/artwork
- Added an A-Z jump bar to the Albums and Artists views, and to any song list sorted alphabetically by title that's long enough for it to be worth it - drag or tap a letter to jump straight there instead of scrolling by hand
- Added a count to a song's right-click menu ("5 songs selected") when several are selected, making it clear the actions below apply to the whole selection - Play now replaces the queue with just the selected songs and starts the first one instead of playing from wherever was clicked through the full list, and Song Radio drops out of the menu since it can't act on more than one song at a time
- Added a "Show all"/"Show less" toggle to an artist page's Most Played list once there are more songs by them than the top 10 shown by default - the section title switches to "All songs" while expanded, and toggling back and forth after the first time is instant

### Changed

- Changed the Home view's two "discover" shelves for more headroom and a clearer distinction between them - the library-based one now shows up to 20 albums instead of 15 on wide screens, and both got clearer titles ("Discover in your library" / "New artists to explore") so it's obvious which is drawn from albums you already own and which is brand-new artist suggestions
- Changed song lists (genres, favorites, search results, playlists, album tracklists) to load more as you scroll instead of paging through numbered pages, matching how the Songs library view already worked
- Changed selecting multiple songs to no longer show a floating action bar - Play Next/Add to Queue/Add to Playlist for the whole selection already live in a selected song's right-click menu, so the bar was just duplicating them; press Escape to clear a selection instead of its old close button
- Changed where an artist page's external links (Spotify, Apple Music, TIDAL, YouTube, Deezer, Discogs, MusicBrainz) show up - they sit next to the Artist Radio button now instead of crowding the top-right corner alongside the rating stars and favorite heart

### Fixed

- Fixed the displayed playback position flickering continuously for the rest of a track after pausing, resuming, or seeking directly on a cast device (e.g. a Sonos speaker) instead of through Beacon - a single real correction kept being treated as still needing another one on every subsequent check instead of settling once it was already accurate
- Fixed casting occasionally auto-advancing to the next queued song a few seconds early, cutting off the tail end of the current one - only happened after pausing/resuming directly on the cast device rather than through Beacon: the auto-advance timer was scheduled once up front and never adjusted for a correction like that happening afterward
- Fixed casting occasionally getting stuck right at the end of a track and never advancing to the next queued song, with the displayed position silently snapping back to 0:00 instead - happened if the cast device reported itself as idle right as the current track was finishing, which was being misread as someone rewinding it back to the very start
- Fixed the displayed playback position (and synced lyrics/the audio visualizer, both tied to it) gradually drifting further out of sync with the actual audio the more a cast session got paused and resumed, eventually landing minutes off; smaller, legitimate corrections now also blend in smoothly instead of visibly jumping
- Fixed pressing Play again immediately after Pause, before the previous action had finished, occasionally jumping a cast session's track backward to an earlier point instead of just resuming
- Fixed the Songs, Albums, and Artists library views getting progressively slower and less responsive the further you scrolled through a large library - every row/card stayed mounted after loading more instead of only the ones actually on screen
- Fixed a song's right-click menu not closing when another song's was opened - each could be opened independently, leaving several stacked on top of each other at once

## [0.1.4] - 2026-08-17

### Added

- Added live sync of the queue, shuffle, and repeat state across every device controlling the same cast session - reordering, adding, or removing a song, or toggling shuffle/repeat, on one device now shows up on every other connected device too (previously only which song was playing and its position stayed in sync; the queue itself was independent per device)
- Added playlist artwork to the Electron Remote Control PWA's playlist list - it only ever showed a plain title/song count before
- Added a fullscreen toggle to the Now Playing view (top right) - hides the rest of the app's chrome around it for a more immersive view; a lyrics button appears alongside it while fullscreen is active, since the usual one (in the player bar) is part of that now-hidden chrome
- Added a flip animation for lyrics on portrait/narrow monitors - the artwork now turns over to reveal lyrics on its back instead of squeezing both side by side or stacking them; also brings lyrics to the mobile web UI for the first time, via a new toolbar button, using the same flip since phones are always portrait too
- Added a Trace log level, one step past Debug - Debug now covers Beacon's own backend code only, Trace also turns on the third-party libraries underneath it (Sonos/AirPlay, HTTP clients) for full SOAP/HTTP-level detail when actually troubleshooting one of those. A new `LOG_LEVEL` environment variable sets the starting level the same way the Settings dropdown does, for a deployment that never comes up far enough to reach Settings
- Added links to Spotify, Apple Music, TIDAL, YouTube, Deezer, Discogs, and MusicBrainz on artist pages, and on the Home "New to explore" shelf - the shelf previously only linked out to Deezer itself (or MusicBrainz as a fallback), and an artist page for someone already in your library had no external links at all

### Changed

- Changed the Electron Remote Control PWA's look to match the mobile web UI - same amber/navy color palette, lighthouse app bar, tab bar icons/labels, Now Playing layout (single row of transport controls, filled play button, cast toggle next to the volume slider), and themed seek/volume sliders instead of its own separate blue-accented style with plain browser-default sliders
- Changed the lyrics view's "pick a different match" list on mobile from a dropdown menu to a full-width sheet - easier to hit and to read than a small floating panel anchored to a toolbar button
- Various small UI sizing/spacing tweaks (mobile web UI, Now Playing on wide monitors, lyrics on mobile) based on actually using it

### Fixed

- Fixed the app log file (see 0.1.3) tagging every line from the backend as an error, even completely normal status messages - the backend logs everything to the same output stream regardless of severity, same as most command-line programs, and the log file was mistaking that stream choice for severity
- Fixed queue changes made while casting (reordering, adding, removing, shuffling) not being followed by auto-advance once nothing was around to manually skip to the next song - the cast target kept auto-advancing through whatever queue order was active when the current song started, ignoring anything changed since
- Fixed picking a cast target while local playback was paused starting playback on that device right away instead of staying paused
- Fixed the Previous/Next buttons resuming playback immediately even if it was paused - navigating now stays paused, matching what selecting a cast target already did
- Fixed the "now playing" display occasionally showing a different song than what was actually playing when two devices controlled the same cast session and both changed something around the same time
- Fixed shuffle not actually shuffling the first song when playing a whole playlist/album from the top - it always started on track 1 in its original order, with shuffle only kicking in from the second song onward
- Fixed the mobile web view carrying over a tab's scroll position into whichever tab you switched to next, instead of each tab keeping (and restoring) its own
- Fixed the Docker/web deployment's audio stream to cast devices being vulnerable to nginx buffering it all at once instead of forwarding it continuously in real time - could turn a brief network hiccup mid-song into a multi-minute stall stuck at 0:00 instead of recovering
- Fixed synced lyrics opened mid-song showing the very first line instead of scrolling straight to wherever playback actually is - it caught up on its own once the next line's timestamp passed, but sat at the wrong spot until then
- Fixed dragging a track to swap it with the very next one in the queue landing it one position further than intended - the drop target only accounted for which row you dropped on, not which half of it, so a drag moving down past a row's own boundary silently pulled in the row after it too
- Fixed pressing Play again after a cast session's queue finished playing (no repeat, last song ended): position stayed frozen at 0:00 and the audio visualizer/synced lyrics never got going, since resuming just asked the already-finished stream to continue instead of properly restarting it - the same bug fixed for local playback in 0.1.1, which never covered casting
- Fixed the Home "Discover" shelf's Reroll button rarely changing anything - which artists its suggestions were seeded from was picked the same way every time (always your top few most-played, in the same order) rather than varying, so a reroll usually landed right back on the same result; suggestions also now refresh daily instead of monthly
- Fixed a temporary MusicBrainz outage or rate-limit response permanently blanking out an artist's info (recommendations, external links) instead of just that one attempt - a failed lookup was being cached the exact same way as a genuine "nothing found" result, so it never got retried later once MusicBrainz recovered

### Removed

- Removed the `DEBUG` environment variable - it only ever gated the API docs at `/api/docs` (unauthenticated by design, not something a real deployment needs reachable) and, separately, some backend developer-testing toggles; log verbosity now has its own `LOG_LEVEL` variable instead (see Added)

### Security

- Updated Electron from 38 to 39, closing out a batch of upstream security advisories Dependabot flagged (context isolation, protocol handling, and related renderer-process issues)

## [0.1.3] - 2026-08-16

### Added

- Added a log file for the Electron app (`logs/main.log` in its data directory, next to the previous session's `main.log.old`) - previously nothing was recorded at all outside of a terminal, making it hard to diagnose an issue after the fact

### Fixed

- Fixed a follow-up cause of the "Connect backend unreachable" startup error (see 0.1.1): the app window could start loading before the bundled backend process had actually finished starting up and begun listening - Electron now waits for it to be reachable first
- Fixed the packaged app icon (see 0.1.2) not actually rendering correctly on Windows/Linux - now built from a proper multi-resolution icon file instead of relying on an automatic single-image conversion
- Fixed casting device discovery and Remote Control pairing potentially failing silently on macOS 14+ due to a missing local-network-access permission description
- Fixed the queue collapsing to just the currently-playing song while casting: whenever the cast target auto-advanced to a song the app already had queued, it was rebuilding the whole queue from scratch around that one song instead of just following along
- Fixed casting always auto-advancing to the next song a little early, cutting off the tail end of the current one - the auto-advance timer wasn't accounting for the casting device's own startup-buffering delay, the same correction its displayed position already used
- Fixed the casting device's startup-buffering calibration sometimes never completing (falling back to a rough guess for the whole track, throwing off lyrics sync and auto-advance timing) - a device legitimately reporting position 0 right at track start was being treated the same as no reading at all and skipped

## [0.1.2] - 2026-08-16

### Added

- Added the app icon (desktop entry, browser tab, installers) - previously only showed Electron's generic default icon there; still the same lighthouse mark used throughout the app itself

### Fixed

- Fixed the casting device menu jittering slightly every few seconds while open: its background refresh was briefly flashing a loading indicator on every tick, nudging the list
- Fixed the volume slider on a paired phone's Remote Control screen briefly snapping back after releasing it while casting to a single device

## [0.1.1] - 2026-08-16

### Fixed

- Fixed a spurious "Connect backend unreachable" error on Electron startup: silent re-login on app boot now always resolves the current connect backend address instead of reusing the previous session's, which could point at a port that's no longer in use
- Fixed pressing Play after a queue finished playing (no repeat, last song ended): the track would restart audibly but the progress bar and audio visualizer stayed frozen; playback now restarts properly instead of resuming an already-finished track
- Fixed local playback sometimes starting on its own right after logging in: the "continue where you left off" resume was firing after any successful login, not just an app restart, so it could auto-play whatever was persisted from a previous session

## [0.1.0] - 2026-08-16

First release - no previous version to compare against yet, so there's nothing to list here. See the README for what Beacon can do.
