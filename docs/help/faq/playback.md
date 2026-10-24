---
order: 3
---

# How playback behaves

## Why do long songs stop early on an older Sonos?

**A Play:3 or a first-generation Playbar stops reading a stream 30 to 45 seconds after it starts, and then plays only what it took in by then.** Newer Sonos models do not do this. How much that is depends on how the song is sent, so Settings → Advanced → "Older Sonos speakers" offers three ways. The setting applies to these two models only; every other speaker always gets its music at playback speed.

- **Whole song at once** (the default). Beacon sends the song as fast as it is made, and in those first seconds the speaker takes in as much as its memory holds: about 14 MB on a Play:3, six minutes of a 320 kb/s MP3, and about 5 MB on a Playbar, two minutes. A shorter song plays through. A longer one ends early, and pause and play carries it on from where it stopped.
- **At playback speed, like a radio station.** Beacon stays a few seconds ahead of the speaker and sends no faster than it plays, the way an internet radio station does, and these speakers play a station for as long as it runs. If one stops reading this way too, the song stops about a minute in.
- **As a file the speaker fetches in parts.** The song goes out as a file of known length that the speaker may fetch piece by piece, the way Sonos plays music from a NAS. It is always a 320 kb/s MP3, so a lossless song arrives lossy on these two speakers, and a file whose own length information is wrong can end in a few seconds of silence.

Which of the two newer ways keeps a long song going on these speakers is not settled yet. With one of them at home, trying both with a song longer than seven minutes and reporting back in [#56](https://github.com/mihaitom/beacon/issues/56) settles it.

**Seeing what happens:** with the log level at Debug (Settings → Advanced), Now Playing shows a small panel while casting: what was sent and how far into the song it reaches, whether the speaker is still reading (`STALLED` once it has stopped), how many seconds it has ahead, and what it asked for. A `GET` with a byte range is the speaker fetching the next part of a file. The whole case, with the measurements, is in [investigations/old-sonos-models-stop-reading-the-stream.md](../../investigations/old-sonos-models-stop-reading-the-stream.md).

## Why can Beacon feel slower with Jellyfin?

**Mostly on the very first load, and then it stops mattering.**

Jellyfin has no Subsonic-compatible API of its own, so `connect` translates every request on the fly into real Jellyfin API calls (see "Jellyfin and Plex support" above). That translating is not what costs the time - Plex goes through the same kind of bridge - Jellyfin's own API is simply slower at handing out a whole library at once. The first full scan of the same 20,000-track library:

| Server             | First full catalog scan |
| ------------------ | ----------------------: |
| Navidrome/Subsonic |                  ~2 sec |
| Plex               |                  ~4 sec |
| Jellyfin 12        |                 ~18 sec |
| Jellyfin 10        |                  ~3 min |

That cost is paid once, not on every visit:

- **The catalog is kept and trusted for a full day on Jellyfin**, against an hour for Navidrome/Subsonic - precisely because re-fetching it is expensive there. Everything after that first scan is answered from Beacon's own copy, and the refresh once the day is up happens in the background while you carry on browsing.
- **Cover art never goes back to Jellyfin twice** either, with three caches in front of it (see "Artwork caching" above) and a whole screenful fetched in a single request.
- **Changed something in Jellyfin and don't want to wait?** The rescan button in Settings drops the copy and fetches fresh right away.

How fast that API answers is Jellyfin's to change from one release to the next, in either direction - if your own numbers look nothing like these, the server version is the first thing to check.

## Why is there no visualizer, ReplayGain or volume slider in the mobile web player?

So that the music keeps playing when the screen locks. Both features need the audio routed through the browser's Web Audio graph, and on iOS that same routing is what makes Safari treat the playback as Web Audio, which it suspends the moment the screen locks or the tab goes to the background. A plain audio element is allowed to carry on, lock screen controls included. Phones and tablets therefore play without that graph, which leaves both features out there. The volume slider goes with them: a phone browser makes an audio element's volume read-only, so that slider never did anything there in the first place - the device's own volume buttons are what changes the level. Nothing changes in the desktop app, in a desktop browser, or while casting - the visualizer's data comes from the `connect` backend during a cast, not from the phone, so it works there either way.

**Casting is unaffected by any of this** - Sonos/Chromecast/AirPlay/DLNA playback is driven entirely by the `connect` backend, independent of whether a browser tab or phone screen is even open, so locking the screen (or closing the tab) doesn't interrupt a cast already in progress.

## Why don't OS media keys / lock screen controls work while casting?

Media keys, the Windows/macOS lock screen controls, and the GNOME/KDE media widget on Linux are all driven by the browser's Media Session API, which only exposes a session to the OS while a real, audible `<audio>` element is actually playing in the tab. While casting, no audio plays locally at all - it goes straight to the Sonos/Chromecast/AirPlay/DLNA device - so there's nothing for the browser to report. Confirmed with local playback (works) vs. casting (doesn't) on both Chromium and Firefox/Gecko-based (e.g. Waterfox) browsers on Linux via `playerctl`. There's a known workaround (loop a silent `<audio>` element to keep a "real" session alive during casting) but it's fragile enough (autoplay policy quirks, volume-zero edge cases) that it's deliberately not implemented - the cast target's own controls (its companion app, physical buttons) already cover this case.

## Why is there no loading strip on the seek bar while casting?

Because nothing is loading here. During a cast the audio goes from the `connect` backend straight to the speaker, which fills its own buffer out of Beacon's reach, so there is no figure to draw: the strip is left out entirely rather than sitting there empty, which would read as "nothing has loaded yet". It is back the moment playback returns to this device. Radio never shows one either, since a live stream has no length to measure a buffer against - which is also why the seek bar is replaced by an elapsed-time readout there.

## Why doesn't the music carry on over my own speakers when I end a cast?

Because nothing here plays that was not asked for. Ending a cast leaves the track on the player bar, paused, at the point the speaker reached; pressing play carries it on this device. The same rule covers a speaker that stops on its own: Beacon cannot tell that apart from somebody pressing stop on the device itself, so it says so and offers to continue rather than deciding for you. The one time audio starts by itself is reloading the app while it was playing locally, which picks up where it left off.

## Why is there no visualizer while a station is casting?

It is switched off there on purpose, because it could not be made to line up. The analyzer is fed the live edge of the stream while the speaker plays roughly 13 seconds behind it, out of its own buffer, so the bars ran ahead of what the room heard. That gap is not a clock offset, so no correction constant closes it; feeding the analyzer delayed audio would, and that is a real piece of work nobody has taken on. A station playing on this device shows its visualizer as usual, and so does a cast library track, whose pacing Beacon controls itself. The measurements are in [investigations/radio-visualizer-cast-sync.md](../../investigations/radio-visualizer-cast-sync.md).
