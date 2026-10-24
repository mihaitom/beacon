---
order: 2
---

# How playback behaves

## Why can Beacon feel slower with Jellyfin?

**Mostly on the very first load, and then it stops mattering.**

Jellyfin has no Subsonic-compatible API of its own, so `connect` translates every request on the fly into real Jellyfin API calls (see [Jellyfin and Plex support](../features.md#jellyfin-and-plex-support)). That translating is not what costs the time - Plex goes through the same kind of bridge - Jellyfin's own API is simply slower at handing out a whole library at once. The first full scan of the same 20,000-track library:

| Server             | First full catalog scan |
| ------------------ | ----------------------: |
| Navidrome/Subsonic |                  ~2 sec |
| Plex               |                  ~4 sec |
| Jellyfin 12        |                 ~18 sec |
| Jellyfin 10        |                  ~3 min |

That cost is paid once, not on every visit:

- **The catalog is kept and trusted for a full day on Jellyfin**, against an hour for Navidrome/Subsonic - precisely because re-fetching it is expensive there. Everything after that first scan is answered from Beacon's own copy, and the refresh once the day is up happens in the background while you carry on browsing.
- **Cover art never goes back to Jellyfin twice** either, with three caches in front of it (see [Artwork caching](../../../README.md#artwork-caching) in the README) and a whole screenful fetched in a single request.
- **Changed something in Jellyfin and don't want to wait?** The rescan button in Settings drops the copy and fetches fresh right away.

How fast that API answers is Jellyfin's to change from one release to the next, in either direction - if your own numbers look nothing like these, the server version is the first thing to check.

## Why is there no visualizer, ReplayGain or volume slider in the mobile web player?

So that the music keeps playing when the screen locks. Both features need the audio routed through the browser's Web Audio graph, and on iOS that same routing is what makes Safari treat the playback as Web Audio, which it suspends the moment the screen locks or the tab goes to the background. A plain audio element is allowed to carry on, lock screen controls included. Phones and tablets therefore play without that graph, which leaves both features out there. The volume slider goes with them: a phone browser makes an audio element's volume read-only, so that slider never did anything there in the first place - the device's own volume buttons are what changes the level. Nothing changes in the desktop app, in a desktop browser, or while casting - the visualizer's data comes from the `connect` backend during a cast, not from the phone, so it works there either way.

**Casting is unaffected by any of this** - Sonos/Chromecast/AirPlay/DLNA playback is driven entirely by the `connect` backend, independent of whether a browser tab or phone screen is even open, so locking the screen (or closing the tab) doesn't interrupt a cast already in progress.
