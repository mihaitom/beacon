# FAQ

Why Beacon behaves the way it does, what leaves the deployment, and what to
check when a speaker does not turn up. `README.md` links here question by
question.

Two neighbours answer related questions: [transcoding-decisions.md](transcoding-decisions.md)
maps out what actually decides the output format on each path, and
[investigations/](investigations/README.md) keeps the cases that took real
digging, including the theories that were ruled out.

## Transitions

### How does the beatmix work?

A beatmix is what a DJ does between two records, done by the Beacon server shortly before a song ends. With Crossfade chosen under Settings, Playback, Transitions, Beacon tries one at every change of song and falls back to an ordinary crossfade where it cannot.

Three words first, since everything below rests on them. The **beat** is the steady pulse you tap your foot to; how many beats come in a minute is the tempo, in **BPM**. Beats come in groups, almost always of four - count "one, two, three, four" along to a pop song and you will land on "one" again and again. One such group is a **bar**, and its "one", usually where the kick drum hits hardest, is the **downbeat**. Songs are built in blocks of bars: a verse or a chorus starts on a downbeat, typically after 4, 8 or 16 bars. A mix that starts and ends on those boundaries sounds like part of the music; one that does not sounds like two songs stumbling over each other.

1. **Finding the beat.** Beacon analyses the last minute of the song that is playing and the first minute of the next one: where the beats fall, how fast they come, and which beat is the "one" of each bar. A BPM your server reports helps as a hint, but is not trusted on its own. It also notes where a song's drums stop before an ambient fade-out, and where they set in after a long intro.
2. **Deciding whether it fits.** Both songs need a clear beat, and their tempos may lie at most 6 % apart, counting double and half time (85 and 170 BPM match). Further apart, the change of speed would be heard, so it becomes a crossfade. Hovering "Crossfade" on Now Playing tells which reason applied.
3. **Matching the tempo.** Over up to eight bars before the mix, the outgoing song eases into the next one's tempo without changing its pitch, and holds it through the mix. The incoming song is never changed, so once it has taken over it plays exactly as recorded.
4. **Lining up the bars.** The mix lasts a whole number of bars - the 4, 8 or 16 you set, fewer where a song leaves no room - and ends on a downbeat where the old song's beat ends; a tail after that is dropped. The new song starts on its own first downbeat, or so far into a long intro that its drums come in right when the basses swap.
5. **Handing over.** The new song's mids and highs (voices, guitars, keyboards, cymbals) come up over the first half while its bass (bassline and kick drum) stays out, since two basslines at once are what makes a mix muddy. Halfway, on a downbeat, the basses swap in one cut. The old song's voice and chords are gone within two bars after that, and around the swap both songs' mids are turned down a little, because that is where voices pile up. Where the next song has synced lyrics, the mix ends as its singing starts.

Songs that follow each other on an album still play gaplessly, and online party guests hear the same mix, since it is made once on the server.

What it does not do is choose the order: the queue decides which songs meet. With most songs tagged with a BPM and shuffle off, "Sort queue by BPM" puts songs of a similar tempo next to each other, so more of them get a beatmix. And it assumes four beats to a bar, so a waltz or a song in 6/8 can be mixed off the bar.

### Why does my speaker's own app show the wrong song with gapless or crossfade on?

With transitions on, Beacon sends a speaker one continuous stream for the whole queue and changes songs inside it, so there is no gap and the songs can blend. The speaker is only told about the stream once, when it starts, so its own app (the Sonos app, Google Home, an AirPlay display) keeps showing the song the stream started with. Beacon itself always shows the right one. Sending the stream as a radio station would let the title change, but a speaker reports no playing position for a station, and Beacon needs that to keep lyrics and the seek bar in time.

### Why is everything converted when transitions are on?

Blending songs, and even joining them without a gap, means decoding them and putting the result into one new stream - there is no file left to send as it is. With a quality limit set, that stream goes out at your limit. Without one, it depends on the speaker:

- **Sonos and AirPlay** get lossless FLAC.
- **Chromecast and DLNA** get AAC at 256 kbps (MP3 at 320 kbps where a device has no AAC). Not every Chromecast is promised to play FLAC - Google only lists it for its audio models - and a DLNA renderer can be any device at all, so neither is sent a FLAC stream that might stay silent.

In Beacon's own player, "Original" plays the mix as lossless FLAC as well, wherever the browser plays FLAC.

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

### Why does Beacon ask for my Navidrome password to edit a smart playlist?

Because Navidrome keeps a smart playlist's rules only in its own API, not in the Subsonic one Beacon uses for everything else, and that API logs in with a password rather than with the token Beacon signed in with. Beacon sends the password it stored at sign-in to its own backend once per session; the backend logs into Navidrome with it, keeps only the session token Navidrome hands back, and uses that token for the playlist endpoints and nothing else. Only when no password is stored (a login taken over from Remote Control, say) or Navidrome no longer accepts it does the editor ask.

### Why are the rules of some smart playlists read-only?

They come from an `.nsp` file in your library. Navidrome reads that file again at the next library scan and would overwrite whatever was changed in Beacon, so the editor shows those rules without letting them be changed. Edit the file instead.

## When something does not turn up

### No devices found

Ensure the container is running with `network_mode: host`. Without host networking, mDNS/SSDP multicast packets can't reach the container and no devices will be discovered.

### My Sonos speaker doesn't appear under AirPlay (or DLNA)

That's intentional. Sonos speakers advertise AirPlay 2 but require MFi hardware authentication that the AirPlay backend (pyatv) can't perform, so they're filtered out of the AirPlay list - use the dedicated **Sonos** output instead, where they appear with full volume and grouping support. Same idea for DLNA - Sonos also answers UPnP discovery there, and gets filtered for the same reason (the dedicated Sonos output already covers it properly). At log level Debug or louder, both filters are off, showing Sonos devices there too - useful for exercising the AirPlay/DLNA code paths themselves without owning that hardware, though actually streaming to Sonos-as-AirPlay still fails for the MFi reason above.

### Troubleshooting casting

Set the log level to Trace in Settings (or `LOG_LEVEL=trace`, see Environment variables above, if the app never comes up far enough to reach Settings) - Debug only covers Beacon's own code, Trace also turns on the SoCo/pyatv/HTTP libraries actually talking to the device, which is normally what you need for a casting issue. Expect a lot of output either way.

## What leaves the deployment

### What does Beacon send to outside services?

Settings > About Beacon > **Privacy** lists every outside service Beacon asks - Radio Browser, the lyrics providers, MusicBrainz, ListenBrainz and the rest - with what each one is asked for, what goes out with the request, and which setting turns it off. It is kept there rather than here so that there is one list, and it is the one in the app.
