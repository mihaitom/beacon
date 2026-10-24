# Sonos: pause and stop fail once the speaker is pulled into another group

**Status:** open, found 2026-09-13 while going through SoCo's errors. Never
seen on a device.

Before `play`, `pause`, `stop` and `seek`, SoCo checks locally with
`only_on_master` (soco/core.py) whether the device is its group's
coordinator, and otherwise raises `SoCoSlaveException` - without asking the
device at all. If someone adds the speaker Beacon is casting to to another
room in the Sonos app, it becomes a follower. `SonosDelivery.pause()`/`stop()`
go through `halt_if_possible()`, which only catches UPnP 701, and the
exception ends up in `classify_delivery_error()` as `unknown` with SoCo's raw
text ("... can only be called/used on the coordinator in a group").

The impact is probably small, and that is exactly what to check before any
fix: as a follower the speaker plays its new coordinator's source, no longer
Beacon's stream. Its GET `/stream` connection should therefore break off, and
`_mark_disconnected_if_not_reconnected()` (routes/stream.py) reports an
interruption after 10 s anyway. What is affected is mainly a pause or stop in
that window. `/stop` still ends the session since the fix of 2026-09-12,
`/pause` answers with `delivery_failed`/`unknown`. `play()` is not affected:
it takes the speaker out of any group with `unjoin()` first.

## Possible fixes

- Treat `SoCoSlaveException` in `halt_if_possible()` like 701, as "nothing of
  ours to stop" - right if the assumption above holds.
- Send commands to `device.group.coordinator` - that would stop the other
  group, and is probably wrong.

Reproduce first: during a cast, add the speaker to another room in the Sonos
app, pause in Beacon, and check in the log whether and when the stream
connection breaks off.
