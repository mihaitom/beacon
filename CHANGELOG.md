# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added a notification when a speaker you're casting to stops on its own: instead of the music just ending in silence, a message says which device dropped out and offers a Resume button that picks playback back up from where it left off. It shows up on the desktop, in the mobile web player and on the phone remote. Beacon deliberately doesn't restart playback by itself, since a speaker being stopped on purpose and one dropping out look exactly the same from its side
- Added Autoplay - once the queue is down to its last song or so, similar songs get added automatically so playback never just runs dry. Off by default; toggle it from the icon next to Queue in the player bar, and set how many songs get added per top-up in Settings. Works the same for local playback and casting, and keeps topping the queue up on its own server-side even if nothing's around to do it locally (e.g. a phone's screen is locked)
- Added Song Radio, Artist Radio, and Autoplay support for Plex (needs an active Plex Pass on the account) - previously Navidrome/Subsonic and Jellyfin only
- Added OS media key support - play/pause/previous/next now work from the keyboard's media keys, the lock screen on Windows/macOS, and the media widget on GNOME/KDE, showing the current song's title/artist/artwork
- Added an A-Z jump bar to the Albums and Artists views, and to any song list sorted alphabetically by title that's long enough for it to be worth it - drag or tap a letter to jump straight there instead of scrolling by hand
- Added a count to a song's right-click menu ("5 songs selected") when several are selected, making it clear the actions below apply to the whole selection - Play now replaces the queue with just the selected songs and starts the first one instead of playing from wherever was clicked through the full list, and Song Radio drops out of the menu since it can't act on more than one song at a time
- Added a "Show all"/"Show less" toggle to an artist page's Most Played list once there are more songs by them than the top 10 shown by default - the section title switches to "All songs" while expanded, and toggling back and forth after the first time is instant
- Added a play icon to the numbers in the Stats page's Top Songs/Artists/Albums/Genres lists, replacing the repeated "X plays" text next to each entry
- Added a second quick-play action to the Songs, Genre, Albums, and Artists views, alongside the already-random one: picks from what's actually been played a lot instead of the whole (or, for a genre, whole-genre) pool, so it leans toward music you already like rather than being a total shot in the dark
- Added an automatic peek at the queue whenever something lands in it without being clicked song-by-song - those quick-play actions, Play Next/Add to Queue, Song Radio, Artist Radio, and Autoplay's own top-up all trigger it. The queue opens with each track fading in one after another and scrolls to whatever's currently playing, then closes itself again after a few seconds unless the mouse actually reaches it, in which case it stays open
- Added a matching fade-out to clearing the queue - tracks disappear bottom-to-top starting from wherever you've actually scrolled to, instead of all at once
- Added a "Stop all" action to the mobile web UI's device picker, matching the one already on desktop - previously the only way to back out of casting there was picking "This device", which also switches playback to it right away
- Added a way to save the current queue as a new playlist, right from the queue drawer
- Added a confirmation prompt before deleting a playlist

### Changed

- Changed notifications to stop counting down while the mouse is over them, and to stay up longer when they're asking you to decide something rather than just telling you what happened
- Changed how Beacon talks to the music server so connections are held open and reused properly, instead of most of them being torn down and rebuilt between requests: browsing and scrolling through a large library is noticeably quicker, and a burst of requests no longer disrupts anything currently casting
- Changed the device picker so the ticked devices are simply where you want playback to go, applied in one step: unticking one no longer stops it on the spot, so switching from one speaker to another no longer drops back to this device's own speakers in between. The button now reads "Apply" and only appears when there is actually something to change
- Changed an artist page's albums from a wrapping grid to a scrollable row (like the Home view's shelves), sorted newest-first by default with a toggle to flip it to oldest-first
- Changed the Home view's two "discover" shelves for more headroom and a clearer distinction between them - the library-based one now shows up to 20 albums instead of 15 on wide screens, and both got clearer titles ("Discover in your library" / "New artists to explore") so it's obvious which is drawn from albums you already own and which is brand-new artist suggestions
- Changed song lists (genres, favorites, search results, playlists, album tracklists) to load more as you scroll instead of paging through numbered pages, matching how the Songs library view already worked
- Changed selecting multiple songs to no longer show a floating action bar - Play Next/Add to Queue/Add to Playlist for the whole selection already live in a selected song's right-click menu, so the bar was just duplicating them; press Escape to clear a selection instead of its old close button
- Changed where an artist page's external links (Spotify, Apple Music, TIDAL, YouTube, Deezer, Discogs, MusicBrainz) show up - they sit next to the Artist Radio button now instead of crowding the top-right corner alongside the rating stars and favorite heart
- Changed cover art to only load once scrolling actually comes to rest on it, and to be cached by the browser afterward, instead of every cover on a page loading at once - large grids and lists load noticeably faster, flicking through a huge list no longer fetches a cover for every song it races past on the way, and coming back to a list no longer re-fetches art that was already shown
- Changed the seek bar to stop stretching past 600px wide on very wide monitors
- Changed the fullscreen visualizer's cast mode to only analyze the audio while somebody actually has it open, instead of doing that work for every cast whether or not anyone was watching - casting is noticeably lighter on the server, and opening the visualizer part-way through a song picks the music up where it is

### Fixed

- Fixed the app going unresponsive for up to about 1.5 seconds the first time it scans for devices after starting, which also held up the audio being sent to a speaker for that moment if something was already casting - opening the device picker mid-playback was enough to trigger it
- Fixed a speaker that briefly lost its connection starting the current song over from the beginning instead of picking it up where it was, which also left the progress bar, synced lyrics and the visualizer jumping around afterwards - bad enough that the only way out was reloading the app and skipping the song
- Fixed casting stopping roughly half an hour into a long track - a DJ set, a live recording, a long mix - whenever no Beacon window was open anywhere. The music simply ended mid-track and the speaker went quiet, as if the device had dropped out
- Fixed a speaker being stopped out of the blue about half an hour after a session was last used, even when something else had started playing on it in the meantime - another device in the house, another person, or a second copy of Beacon. Cleaning up a forgotten session now only stops a speaker if it is still playing what that session actually sent it
- Fixed the app locking up for a moment while the seek bar's waveform was being prepared for a very long track, such as a DJ mix or a live set: with playback going to a speaker, the pause was long enough to interrupt the audio being sent to it
- Fixed casting stopping altogether when the music server got briefly slow to answer - browsing a large library while casting could be enough - instead of just carrying on with the next song; looking a song up also no longer holds up the audio being sent to the speakers while it waits
- Fixed picking a second device while already casting silently dropping the first one - it kept playing until the end of the current track and then went quiet, with only the newly picked device carrying on
- Fixed the displayed position while casting going wrong in a whole family of ways, taking the synced lyrics and the audio visualizer with it since both follow it: it could flicker for the rest of a track, briefly run ahead of what was audible after resuming, snap back toward 0:00 after a restart or seek, or drift further out with every pause until it was minutes off. Mostly noticeable when a speaker was paused, resumed or seeked from the speaker itself rather than through Beacon. Corrections now settle once they are actually accurate and blend in smoothly instead of visibly jumping, and pressing Play again right after Pause no longer jumps the track backward
- Fixed casting mishandling the end of a track in two opposite ways: it could advance to the next song a few seconds early and cut off the tail of the current one, or get stuck at the end and never move on at all, with the position quietly snapping back to 0:00 instead. Both came from a cast device being paused, resumed or reporting itself idle at exactly the wrong moment
- Fixed a cast session occasionally getting stuck looping near 0:00 with no audio, indefinitely, particularly on long tracks or compilation albums - streaming had no pacing, so formats that don't need re-encoding could reach a cast device many times faster than actual playback, leaving its connection sitting idle for long stretches once everything was already sent and prone to being dropped there; streaming now stays paced only a little ahead of real playback instead. A drop that still happens now also recovers within seconds instead of the display getting stuck resyncing against the disconnected device's "nothing playing" reading as an endless string of rewinds to the start
- Fixed joining an unreachable device to an existing cast session leaving it stuck marked as in-use for everyone else, even though nothing was actually playing on it
- Fixed casting to several devices at once silently appearing to succeed, with no error shown and every device staying marked in-use, when none of them actually managed to start playing
- Fixed the Electron Remote Control pairing occasionally reporting the app as unreachable right after a quick reconnect (a brief network blip, for example), even though it was already back and listening again
- Fixed the seek bar's waveform occasionally overflowing into neighboring player bar elements at narrower window widths instead of shrinking to fit
- Fixed a ReplayGain-adjusted track not playing at all while casting if its format didn't need re-encoding (MP3, FLAC, AAC, Ogg Vorbis) - the volume adjustment and that format's fast, lossless pass-through can't be combined; such a track now gets a quick re-encode instead so ReplayGain still applies
- Fixed a deleted playlist reappearing in the Playlists view, sometimes for up to an hour afterward - deleting it updated what was on screen right away, but not the on-device cache checked first on the next visit
- Fixed a rare inconsistency after force-taking over a device from another session: if that session's own attempt to (re)start playback on the same device failed at almost the same moment, its failure cleanup could undo the takeover, leaving both sessions disagreeing about who actually has the device until something else refreshed it
- Fixed the Songs, Albums, and Artists library views getting progressively slower and less responsive the further you scrolled through a large library - every row/card stayed mounted after loading more instead of only the ones actually on screen
- Fixed a song's right-click menu not closing when another song's was opened - each could be opened independently, leaving several stacked on top of each other at once
- Fixed clearing the queue while casting getting silently undone a few seconds later, with every song reappearing - the clear never made it past this device to the cast session itself

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
