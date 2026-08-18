# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Fixed the casting device menu jittering slightly every few seconds while open: its background refresh was briefly flashing a loading indicator on every tick, nudging the list

## [0.1.1] - 2026-08-16

### Fixed

- Fixed a spurious "Connect backend unreachable" error on Electron startup: silent re-login on app boot now always resolves the current connect backend address instead of reusing the previous session's, which could point at a port that's no longer in use
- Fixed pressing Play after a queue finished playing (no repeat, last song ended): the track would restart audibly but the progress bar and audio visualizer stayed frozen; playback now restarts properly instead of resuming an already-finished track
- Fixed local playback sometimes starting on its own right after logging in: the "continue where you left off" resume was firing after any successful login, not just an app restart, so it could auto-play whatever was persisted from a previous session

## [0.1.0] - 2026-08-16

First release - no previous version to compare against yet, so there's nothing to list here. See the README for what Beacon can do.
