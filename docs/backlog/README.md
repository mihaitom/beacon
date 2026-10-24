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
- [UPnP 737/738/739 as a failure reason of their own](casting/upnp-737-739-failure-reason.md) - "the speaker cannot reach the stream's address" instead of `unknown`
- [One device dropping out of a multi-target cast is never surfaced](../investigations/casting/multi-target-drop-not-surfaced.md) - shelved 2026-08-28, no small fix; the analysis is an investigation

## Radio

- [Radio stations are global instead of per account](radio/stations-per-account.md) - the migration is decided (every account branches off the existing list), not built

## Remote Control

- [Remote: "Play All" does not wait for the ack](remote-control/play-all-waits-for-ack.md) - small, the pattern is in `js/sheet.js`
- [Remote: an album detail view](remote-control/album-detail-view.md) - four places, the last planned alignment with the mobile view

## Integrations

- [Home Assistant for Docker/web too](integrations/home-assistant-for-docker.md) - two ways, decided only once someone asks

## Packaging and dependencies

- [Dependency majors: Vite 8 and TypeScript 7](packaging/dependency-majors.md) - Vite 8 unblocked, TypeScript 7 to check again
- [The Windows arm64 installer carries x64 binaries](packaging/windows-arm64-installer-x64-binaries.md) - drop the target or build natively
