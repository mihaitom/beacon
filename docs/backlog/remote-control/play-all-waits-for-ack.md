# Remote: "Play All" in a playlist does not wait for the ack

**Status:** open, noticed going through the Remote Control on 2026-09-13.

The button in `renderPlaylistDetail()`
(`connect/static/remote/js/views/playlists.js`) calls
`fireCommand('play-playlist', ...)`, and `fireCommand()` is deliberately the
fire-and-forget branch: it drops the promise from `sendCommand()` and only
catches the failure (`js/api.js`). The request/ack path that exists goes
unused here - the button never knows whether the command arrived.

That is not theoretical, because a command is acked when it is **done**, not
when it was accepted: `COMMAND_TIMEOUT` in `connect/routes/remote.py` is 45 s
against 8 s for a query (`QUERY_TIMEOUT`), with the reason right next to it -
with a cast target involved, `playback.applyTargets()` waits on a real UPnP /
Chromecast / AirPlay handshake. Someone casting to a speaker who taps "Play
All" gets no feedback at all for seconds, and on a 504/502 only the global
banner `fireCommand()` raises through `beacon-remote-command-failed` -
unrelated to the button they pressed.

## To do

Switch to `sendCommand()` and handle the returned promise at the button. The
pattern is already in the repo: `js/sheet.js` does it for the action sheet's
buttons - a `pending` flag against a double tap, the icon set to
`mdi mdi-loading mdi-spin`, every button `disabled`, and both undone in the
rejection branch. Two things to decide:

- whether a failure still raises the global banner (then the change has to
  dispatch `beacon-remote-command-failed` itself, which otherwise only comes
  from `fireCommand()`) or shows at the button instead;
- whether the song rows of the same view come along - their `onPlay` fires
  the same `play-playlist` with `startIndex` and has exactly the same gap.

The ack question concerns the whole Remote, not only this button:
`fireCommand()` is deliberately the normal case for transport buttons, volume
and queue rows, where there is nothing to show. This is about the subset that
takes noticeably long and has a surface of its own to show it on.
