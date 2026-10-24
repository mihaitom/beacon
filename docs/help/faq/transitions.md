---
order: 3
---

# Transitions

## How does the beatmix work?

A beatmix is what a DJ does between two records, done by the Beacon server shortly before a song ends. With Crossfade chosen under Settings, Playback, Transitions, Beacon tries one at every change of song and falls back to an ordinary crossfade where it cannot.

Three words first, since everything below rests on them. The **beat** is the steady pulse you tap your foot to; how many beats come in a minute is the tempo, in **BPM**. Beats come in groups, almost always of four - count "one, two, three, four" along to a pop song and you will land on "one" again and again. One such group is a **bar**, and its "one", usually where the kick drum hits hardest, is the **downbeat**. Songs are built in blocks of bars: a verse or a chorus starts on a downbeat, typically after 4, 8 or 16 bars. A mix that starts and ends on those boundaries sounds like part of the music; one that does not sounds like two songs stumbling over each other.

1. **Finding the beat.** Beacon analyses the last minute of the song that is playing and the first minute of the next one: where the beats fall, how fast they come, and which beat is the "one" of each bar. A BPM your server reports helps as a hint, but is not trusted on its own. It also notes where a song's drums stop before an ambient fade-out, and where they set in after a long intro.
2. **Deciding whether it fits.** Both songs need a clear beat, and their tempos may lie at most 6 % apart, counting double and half time (85 and 170 BPM match). Further apart, the change of speed would be heard, so it becomes a crossfade. Hovering "Crossfade" on Now Playing tells which reason applied.
3. **Matching the tempo.** Over up to eight bars before the mix, the outgoing song eases into the next one's tempo without changing its pitch, and holds it through the mix. The incoming song is never changed, so once it has taken over it plays exactly as recorded.
4. **Lining up the bars.** The mix lasts a whole number of bars - the 4, 8 or 16 you set, fewer where a song leaves no room - and ends on a downbeat where the old song's beat ends; a tail after that is dropped. The new song starts on its own first downbeat, or so far into a long intro that its drums come in right when the basses swap.
5. **Handing over.** The new song's mids and highs (voices, guitars, keyboards, cymbals) come up over the first half while its bass (bassline and kick drum) stays out, since two basslines at once are what makes a mix muddy. Halfway, on a downbeat, the basses swap in one cut. The old song's voice and chords are gone within two bars after that, and around the swap both songs' mids are turned down a little, because that is where voices pile up. Where the next song has synced lyrics, the mix ends as its singing starts.

Songs that follow each other on an album still play gaplessly, and online party guests hear the same mix, since it is made once on the server.

What it does not do is choose the order: the queue decides which songs meet. With most songs tagged with a BPM and shuffle off, "Sort queue by BPM" puts songs of a similar tempo next to each other, so more of them get a beatmix. And it assumes four beats to a bar, so a waltz or a song in 6/8 can be mixed off the bar.

## Why does my speaker's own app show the wrong song with gapless or crossfade on?

With transitions on, Beacon sends a speaker one continuous stream for the whole queue and changes songs inside it, so there is no gap and the songs can blend. The speaker is only told about the stream once, when it starts, so its own app (the Sonos app, Google Home, an AirPlay display) keeps showing the song the stream started with. Beacon itself always shows the right one. Sending the stream as a radio station would let the title change, but a speaker reports no playing position for a station, and Beacon needs that to keep lyrics and the seek bar in time.

## Why is everything converted when transitions are on?

Blending songs, and even joining them without a gap, means decoding them and putting the result into one new stream - there is no file left to send as it is. With a quality limit set, that stream goes out at your limit. Without one, it depends on the speaker:

- **Sonos and AirPlay** get lossless FLAC.
- **Chromecast and DLNA** get AAC at 256 kbps (MP3 at 320 kbps where a device has no AAC). Not every Chromecast is promised to play FLAC - Google only lists it for its audio models - and a DLNA renderer can be any device at all, so neither is sent a FLAC stream that might stay silent.

In Beacon's own player, "Original" plays the mix as lossless FLAC as well, wherever the browser plays FLAC.
