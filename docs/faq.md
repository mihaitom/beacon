# FAQ

Why Beacon behaves the way it does, what leaves the deployment, and what to
check when a speaker does not turn up. `README.md` links here question by
question.

Two neighbours answer related questions: [transcoding-decisions.md](transcoding-decisions.md)
maps out what actually decides the output format on each path, and
[investigations/](investigations/README.md) keeps the cases that took real
digging, including the theories that were ruled out.

## Formats and converting

### Do I need ffmpeg installed?

No. Both the Docker image and the desktop app bring their own build - an audio-only one, about a tenth the size of a full ffmpeg, built from the same recipe for both (see [build/ffmpeg/README.md](../build/ffmpeg/README.md)). Setting `FFMPEG_PATH` points Beacon at your own build instead. Should it ever be missing - a build packaged without it, or a development checkout with no ffmpeg on PATH - the connect log says so on startup and casting fails.

### What actually gets sent to a speaker, and when is it converted?

Sonos, Chromecast and DLNA pull the audio from Beacon over HTTP, so Beacon decides what shape it arrives in. (AirPlay is pushed to rather than pulling, via pyatv, but gets the same prepared stream; only a live radio URL goes to the device untouched.)

The rule is **change as little as possible, and never in a way that makes the stream bigger and worse.** For each track, the first of these that applies wins:

1. **A quality limit you set**, if the track is above it. Settings -> Playback caps what gets sent. Being a cap is the whole point: a 128kbps file under a "MP3 320" limit is left alone, because re-encoding it would lose quality _and_ produce a larger stream. Only a track above the limit is brought down to it.
2. **Sent as it is**, if the speaker plays that format. Nothing is decoded or re-encoded and nothing is lost - a 320kbps MP3 arrives as exactly that MP3.
3. **Repacked to FLAC**, if the track is lossless but in a wrapper the speaker will not open. Every bit is kept, only the container changes.
4. **Re-encoded to 192kbps MP3**, when none of the above fits. The last resort, and the one format every device here plays.

Steps 2 and 3 depend on the speaker, and this is the whole of that difference:

| Plays      | MP3 | AAC | FLAC | Ogg Vorbis | Opus |
| ---------- | --- | --- | ---- | ---------- | ---- |
| Chromecast | yes | yes | yes  | yes        | yes  |
| Sonos      | yes | yes | yes  | yes        | no   |
| DLNA       | yes | yes | yes  | yes        | no   |
| AirPlay    | yes | no  | yes  | yes        | no   |

Which lands sources in three groups. Already in the table: MP3, AAC, FLAC, Ogg Vorbis and Opus, sent as they are wherever the row says yes. Lossless but not in the table, so repacked to FLAC: ALAC, WAV, AIFF, APE, WavPack, TTA, Shorten, WMA Lossless and DSD. Everything else, re-encoded to MP3: WMA, Musepack, MP2 and anything unrecognised.

Three things are worth knowing because they surprise people:

- **Opus is only sent untouched to a Chromecast.** A Sonos accepts an Opus stream and then plays silence rather than refusing it, and nothing downstream can notice that, so Beacon does not try. An Opus file becomes MP3 there. This is separate from Beacon being able to _encode_ to Opus, which it does for any device that plays it.
- **ReplayGain rules out step 2.** Adjusting the volume means decoding the audio, and a track sent as it is never gets decoded. With ReplayGain on, a track that would have been passed through is re-encoded instead.
- **A speaker's sample-rate and bit-depth limits apply on top of all of this.** A 96kHz/24-bit FLAC sent to a device that stops at 48kHz is resampled down rather than sent and cut off a second in. DSD is brought down the same way: it decodes to 352.8kHz, which nothing plays, so it lands at 88.2kHz - the same conversion a DSD player makes.

### And in Beacon's own player?

Same idea, one step shorter, because there is no speaker to negotiate with - only the browser. Settings -> Playback has its own limit for this, separate from the casting one:

1. **Converted, whatever the setting says**, if the browser cannot decode the file at all. On "Original" it is repacked to FLAC rather than re-encoded, so nothing is lost; only where even FLAC is refused does it become MP3 or AAC. This is what makes an ALAC, APE, WavPack, AIFF or DSD library playable in a browser at all.
2. **Brought down to your limit**, if the track is above it. A lossless track always is, whatever number the limit names.
3. **Played as it is**, otherwise.

MP3, AAC and Opus are offered as limits here, and which of them you are shown depends on the browser: Beacon asks it what it can decode rather than assuming, because the answer differs. Safari has no Ogg decoder, so Opus is not offered there and an Ogg Vorbis or Opus _file_ is converted for it - the same file plays untouched in Chrome or Firefox. Both limits are stored per device, so a phone on mobile data and a desktop on the LAN can be set differently.

### Why is a surround track quieter than everything else?

Folding five or more channels into two costs level, and that fold happens whenever the audio has to be stereo: on every cast, since no cast target here plays surround (a Sonos answers a multichannel FLAC with silence rather than an error), and in this app's own player at every quality setting except "Original".

**Nothing in Beacon turns anything down.** It is ffmpeg's own default downmix, which scales the mix so that even fully correlated channels cannot clip. Measured on decorrelated pink noise: -4.7 dB for quad, -7.7 dB for 5.0, -7.6 dB for 5.1, -9.9 dB for 7.1. It depends on the channel layout and on nothing else, so the same figure applies to quiet and loud material alike.

"Original" in this app's own player keeps every channel and leaves the folding to the browser, which does not apply that normalisation - which is why the same file can sound right there and noticeably quieter when cast. Sending it at full level was measured rather than dismissed: it lands exactly on the clipping point for material that is not really a surround mix, so ffmpeg's default stays. [investigations/multichannel-flac-silent-on-sonos.md](investigations/multichannel-flac-silent-on-sonos.md) has the numbers.

## How playback behaves

### Why can Beacon feel slower with Jellyfin?

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

### Why is there no visualizer, ReplayGain or volume slider in the mobile web player?

So that the music keeps playing when the screen locks. Both features need the audio routed through the browser's Web Audio graph, and on iOS that same routing is what makes Safari treat the playback as Web Audio, which it suspends the moment the screen locks or the tab goes to the background. A plain audio element is allowed to carry on, lock screen controls included. Phones and tablets therefore play without that graph, which leaves both features out there. The volume slider goes with them: a phone browser makes an audio element's volume read-only, so that slider never did anything there in the first place - the device's own volume buttons are what changes the level. Nothing changes in the desktop app, in a desktop browser, or while casting - the visualizer's data comes from the `connect` backend during a cast, not from the phone, so it works there either way.

**Casting is unaffected by any of this** - Sonos/Chromecast/AirPlay/DLNA playback is driven entirely by the `connect` backend, independent of whether a browser tab or phone screen is even open, so locking the screen (or closing the tab) doesn't interrupt a cast already in progress.

### Why don't OS media keys / lock screen controls work while casting?

Media keys, the Windows/macOS lock screen controls, and the GNOME/KDE media widget on Linux are all driven by the browser's Media Session API, which only exposes a session to the OS while a real, audible `<audio>` element is actually playing in the tab. While casting, no audio plays locally at all - it goes straight to the Sonos/Chromecast/AirPlay/DLNA device - so there's nothing for the browser to report. Confirmed with local playback (works) vs. casting (doesn't) on both Chromium and Firefox/Gecko-based (e.g. Waterfox) browsers on Linux via `playerctl`. There's a known workaround (loop a silent `<audio>` element to keep a "real" session alive during casting) but it's fragile enough (autoplay policy quirks, volume-zero edge cases) that it's deliberately not implemented - the cast target's own controls (its companion app, physical buttons) already cover this case.

### Why is there no loading strip on the seek bar while casting?

Because nothing is loading here. During a cast the audio goes from the `connect` backend straight to the speaker, which fills its own buffer out of Beacon's reach, so there is no figure to draw: the strip is left out entirely rather than sitting there empty, which would read as "nothing has loaded yet". It is back the moment playback returns to this device. Radio never shows one either, since a live stream has no length to measure a buffer against - which is also why the seek bar is replaced by an elapsed-time readout there.

### Why doesn't the music carry on over my own speakers when I end a cast?

Because nothing here plays that was not asked for. Ending a cast leaves the track on the player bar, paused, at the point the speaker reached; pressing play carries it on this device. The same rule covers a speaker that stops on its own: Beacon cannot tell that apart from somebody pressing stop on the device itself, so it says so and offers to continue rather than deciding for you. The one time audio starts by itself is reloading the app while it was playing locally, which picks up where it left off.

### Why is there no visualizer while a station is casting?

It is switched off there on purpose, because it could not be made to line up. The analyzer is fed the live edge of the stream while the speaker plays roughly 13 seconds behind it, out of its own buffer, so the bars ran ahead of what the room heard. That gap is not a clock offset, so no correction constant closes it; feeding the analyzer delayed audio would, and that is a real piece of work nobody has taken on. A station playing on this device shows its visualizer as usual, and so does a cast library track, whose pacing Beacon controls itself. The measurements are in [investigations/radio-visualizer-cast-sync.md](investigations/radio-visualizer-cast-sync.md).

## What the library shows

### Why does the path column show a path that does not exist on disk?

Because that is what the server sent. Navidrome hands Subsonic clients a synthesised path, in the shape `Artist/Album/01-03 - Title.mp3`, rather than the real one, unless "Report Real Path" is switched on for that player in Navidrome's own settings. Beacon shows the value it was given rather than guessing at a nicer one.

### I removed one of two identical tracks from a playlist and both disappeared

On a Jellyfin 12 server the two copies are indistinguishable: it reports the same id for both entries, so a removal names both. Jellyfin's own web client does exactly the same thing on the same playlist, which is what puts this in the server rather than in Beacon. Reordering such a playlist is unreliable there for the same reason.

It cannot happen anywhere else. Jellyfin 10.9 and Plex will not hold the same song twice in the first place - adding a song a playlist already has answers success and changes nothing - and Navidrome removes exactly the copy that was clicked. Measured against real servers on 2026-09-12; [investigations/playlist-duplicate-entries.md](investigations/playlist-duplicate-entries.md) has the payloads, and the two fixes that were weighed and not taken.

## When something does not turn up

### No devices found

Ensure the container is running with `network_mode: host`. Without host networking, mDNS/SSDP multicast packets can't reach the container and no devices will be discovered.

### My Sonos speaker doesn't appear under AirPlay (or DLNA)

That's intentional. Sonos speakers advertise AirPlay 2 but require MFi hardware authentication that the AirPlay backend (pyatv) can't perform, so they're filtered out of the AirPlay list - use the dedicated **Sonos** output instead, where they appear with full volume and grouping support. Same idea for DLNA - Sonos also answers UPnP discovery there, and gets filtered for the same reason (the dedicated Sonos output already covers it properly). At log level Debug or louder, both filters are off, showing Sonos devices there too - useful for exercising the AirPlay/DLNA code paths themselves without owning that hardware, though actually streaming to Sonos-as-AirPlay still fails for the MFi reason above.

### Troubleshooting casting

Set the log level to Trace in Settings (or `LOG_LEVEL=trace`, see Environment variables above, if the app never comes up far enough to reach Settings) - Debug only covers Beacon's own code, Trace also turns on the SoCo/pyatv/HTTP libraries actually talking to the device, which is normally what you need for a casting issue. Expect a lot of output either way.

## What leaves the deployment

### What does Discover send to Radio Browser?

Searching sends what you type, plus the country filter if you set one. Playing a station you found there reports one listen back to the directory, which is what its "most played" ordering is built on: Beacon uses that ordering, so it contributes to it rather than only taking from it. A station you added by typing its address yourself is never reported, because Beacon has no reason to think the directory knows it. All of this goes out from the Beacon server, not from your browser, so what Radio Browser sees is the deployment's address rather than yours.

### What does the recommendations feature send where?

The Discover/"New to explore" shelves on Home resolve a handful of artist names already in your library against MusicBrainz (to get an artist ID) and ListenBrainz (to get similar artists back) - both free, no-account, no-API-key services from the MetaBrainz project. "New to explore" additionally looks up a photo and a link for artists not in your library via Deezer's public search API (also no API key) - the same source Navidrome itself defaults to for artist images. No listening history, usernames, or anything else leaves the deployment - just a short list of artist names. Turn it off in Settings if you'd rather not: that stops the Home shelves. Opening an artist's own page still looks that one artist up for its photo and links, on or off, since that is a single on-demand lookup for the page you are actually looking at rather than a background pass over artists nobody asked about.
