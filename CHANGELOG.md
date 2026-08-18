# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Fixed the app log file (see 0.1.3) tagging every line from the backend as an error, even completely normal status messages - the backend logs everything to the same output stream regardless of severity, same as most command-line programs, and the log file was mistaking that stream choice for severity

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
