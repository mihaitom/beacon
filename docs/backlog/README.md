# Backlog

What is still to be built or decided, one file per item, in one folder per
area - the same layout as [investigations/](../investigations/README.md). A
case that first has to be understood belongs there; this list then only
links to it.

An item is removed when it is done, not ticked off. A finished feature with
a design worth keeping moves to [plans/](../plans/), a case that took real
digging to [investigations/](../investigations/README.md). Name a file after
what is to be done or what is missing (`stations-per-account`), and keep the
status in the file's first lines: when it was found, whether it was ever seen
on a device, what is decided and what is not.

---

## Casting

- [A DLNA renderer that accepts the stream but never fetches it stays silent](casting/dlna-renderer-accepts-but-never-fetches.md) - follows from the code, never seen; needs an AVTransport subscription and a report for tracks
- [Sonos: pause and stop fail once the speaker is pulled into another group](casting/sonos-pause-fails-as-group-member.md) - never seen, probably small; reproduce before fixing
- [One device dropping out of a multi-target cast is never surfaced](../investigations/casting/multi-target-drop-not-surfaced.md) - shelved 2026-08-28, no small fix; the analysis is an investigation

## Radio

- [Radio stations are global instead of per account](radio/stations-per-account.md) - the migration is decided (every account branches off the existing list), not built

## Library

- [Deezer lookups fail or go wrong when an artist was renamed](library/deezer-lookup-with-renamed-artists.md) - seen with one artist only, deliberately not built; ISRC lookup is the smallest step

## Remote Control

- [Remote: an album detail view](remote-control/album-detail-view.md) - four places, the last planned alignment with the mobile view

## Apps and home automation

- [Control and the library: what is still to be run on real speakers and Home Assistant](device-link/control-hardware-check.md) - setup, discovery and nginx done; the rest of the check list is in there
- [Repeat on a server only works while a window is open](device-link/server-repeat-without-a-window.md) - only without transitions; touches auto-advance, needs every speaker type
- [Remove the old Home automation key](device-link/retire-the-integration-key.md) - deprecated, not before a release has carried the notice; the full list of what goes

## Packaging and dependencies

- [Dependency majors: Vite 8 and TypeScript 7](packaging/dependency-majors.md) - Vite 8 unblocked, TypeScript 7 to check again
- [A Windows or Mac build made on Linux ships Linux binaries](packaging/cross-build-ships-host-binaries.md) - exits 0 and reports nothing; the build should refuse
