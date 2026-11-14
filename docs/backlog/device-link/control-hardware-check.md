# Control and the library: what is still to be run on real speakers and Home Assistant

**Status:** open since 2026-11-11, partly run on 2026-11-14. Everything under
"Control and home automation" in [plans/device-link.md](../../plans/device-link.md)
is covered by `connect/tests/test_device_link.py`, but only against stand-in
deliveries and patched playback handlers.

## Already run (2026-11-14)

On a server image, from Home Assistant 2026.9.3:

- Set up by hand against a server address, and from the mDNS discovery of a
  server (through nginx on `WEB_PORT`).
- An entry made with the old integration key went through the repair and kept
  its entity ids.
- Starting a playlist on a server speaker from Home Assistant, after picking
  the speaker while idle; with cast permissions open to admins only.
- `/device-link/` through nginx: the first `/player/events` line arrives at
  once, `: keepalive` every 15 s, the CORS preflight answers `GET, POST` and
  `X-Beacon-Device-Key, Content-Type`, covers arrive whole.

## Still to run

On a server and on the desktop app, with a key that has "Steer playback" and
"Browse the library and start music":

- **A cast an app starts shows in the browser.** With a key made after
  2026-11-14 (it remembers the account's session): a tab already open
  switches to the cast with the right queue; a tab opened afterwards picks it
  up. And with a key made before that, while a browser of the account is
  signed in.
- Account isolation: a key of account A neither sees nor steers B's cast on
  the same server; a desktop key does nothing while the window is signed in
  as somebody else (`available: false`, commands 409 `not_available`).
- Two casts of one account at once: the audible one is steered.
- With the browser tab that started a cast open, and again with it closed:
  pause, play, seek, next, previous (also within the first 5 s), queue jump,
  volume, shuffle on and off, repeat, autoplay. Afterwards the tab must show
  the same queue, song and position. `reconcileFromStatus()` is the part to
  watch: its queue has to match connect's, not snap back.
- The same with transitions (mix) on: shuffle has to keep the song the mix
  has already lined up next.
- A speaker another listener holds: `devices` and `play_*` with `devices`
  answer 409 `device_in_use` on both players, and that listener keeps
  playing. On the desktop no takeover dialog may appear.
- `devices` on a running cast: join a second speaker, then drop the first;
  the music must not stop in between. Per speaker type (Sonos, AirPlay,
  Chromecast, DLNA), since `/join` and `/device-stop` behave differently.
- Volume with two speakers, on the server and on the desktop (there it goes
  out as one `set-device-volume` per speaker).
- Radio from `play_radio`, and its logo from `/player/cover` on both.
- Revoking a key ends an open `/player/events` stream.
- The stored login: 409 `media_login_rejected` once the media server refuses
  it (change the password on a test account).

In Home Assistant:

- A fresh setup from the mDNS discovery of the desktop app.
- On a server no `This computer` in the speaker select (needs an image with
  `/me`'s `player` field).
- Media browser: albums by letter (paging through more than 500), playlists,
  stations, covers and station logos.
- The party sensor's `listen_kbps` on the desktop.

Behind Traefik and Authentik: `/device-link/` passes the forward-auth (see
`docs/help/guides/desktop-and-server.md#behind-a-login`).

Whatever turns up that takes more than a quick fix gets an entry in
`docs/investigations/`.
