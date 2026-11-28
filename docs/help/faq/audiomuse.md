---
group: listening
order: 5
---

# AudioMuse-AI

## What does AudioMuse-AI add to Beacon?

[AudioMuse-AI](https://github.com/NeptuneHub/AudioMuse-AI) is a program you run yourself next to your media server. It listens to every song in your library once and works out how it sounds, which mood it carries and, if you let it, what its lyrics are about. Beacon asks it for songs by that analysis instead of by tags and play counts. Connected, you get:

- **Autoplay** carries on from the last few songs in the queue and steers away from the ones you skipped.
- **Song Radio** and **Artist Radio** pick by sound, on Navidrome, Jellyfin and Plex alike.
- In every song menu, **Discovery Radio** plays songs that sound related but sit further out in your library, and **Path to this song** plays a short bridge of songs from the one playing over to the one you picked.
- **Search** also finds songs by how they sound ("calm piano") and by what their lyrics are about ("leaving home"), in two sections under the ordinary results.
- **Home** gets a "Sounds like you" shelf blended from your most played songs, and **Moods & themes**: one tile per mood (happy, relaxed, party, ...) and per lyric theme (on the road, in love, looking back, ...), each a fresh mix of 50 songs on every click.
- The **playlist builder** on the Playlists page gets AudioMuse as a source: a playlist by mood, by what the lyrics are about, by a description of how it should sound, of songs that sound like one of yours (or are related further out), a path of any length from one song to another, or "Sounds like you". It picks straight from your library, so nothing is missing from the result.
- **Artist pages** show the artists of your library that sound similar, at the bottom on a computer and after the albums on a phone.

Without AudioMuse-AI all of this is either not there or works as before: the radios and Autoplay ask your media server again, and nothing is greyed out or broken.

## How do I connect AudioMuse-AI?

AudioMuse-AI has to run and to have analysed your library first. On a large library that analysis takes a long time - days, not hours - and Beacon can only offer what it has finished. Version 3.7.0 or newer is needed.

1. In AudioMuse-AI, open Administration > Setup Wizard and set an API token (`API_TOKEN`) if there is none yet.
2. In Beacon, open Settings > Advanced > AudioMuse-AI, enter the address under which your Beacon reaches AudioMuse-AI (for example `http://audiomuse:8000` inside Docker, or the computer's address and port), paste the token and save.

The line above the fields says at once whether it worked. On a Beacon server, the address and token can also be set as `AUDIOMUSE_URL` and `AUDIOMUSE_API_KEY` in its environment; what is entered in Settings takes precedence.

## What do the messages in Settings mean?

- **Cannot be reached at this address:** the address is wrong, AudioMuse-AI is not running, or the Beacon server cannot reach it - inside Docker, `localhost` is the Beacon container itself, not the computer.
- **Does not accept this token:** the token differs from the one set in AudioMuse-AI's Setup Wizard.
- **Too old:** update AudioMuse-AI to 3.7.0 or newer.
- **Does not know the songs of your server:** AudioMuse-AI has analysed a different media server than the one you are logged in to. Add yours in AudioMuse-AI and let it analyse the library.

## Does it work with Jellyfin and Plex?

Yes, as long as AudioMuse-AI has that server among its own and has analysed it. If AudioMuse-AI knows several servers, Beacon finds the one you are logged in to by itself: it looks up one song AudioMuse-AI knows on your media server and checks that the title matches. Navidrome is the one that has been tried most; if something seems off with Jellyfin or Plex, please [report it](reporting.md).

## Why do I not see Moods & themes, or the search by sound?

All of it appears only while AudioMuse-AI answers - check the line in Settings first. Beyond that, each part needs its own analysis in AudioMuse-AI:

- **Themes** and the **search by lyrics** need AudioMuse-AI's lyrics analysis. Without it, Home shows the moods alone, and the lyrics section in search stays away.
- **Search by sound** needs AudioMuse-AI's text-to-sound analysis (CLAP).
- **"Sounds like you"** needs songs you have played, since it starts from your most played ones.

## Why are some songs never in the mixes?

AudioMuse-AI can only suggest songs it has analysed. Songs added since its last analysis run turn up once it has run again, and songs from external sources (Settings > Library > External sources) are never part of it, which is also why "Path to this song" is not offered for them.

## Does the desktop app take the settings from my Beacon server?

Yes, if the desktop app is paired with a Beacon server and its device key may share API keys: it then uses the server's address and token, and Settings says so. That only goes one way - what you enter on the desktop stays on the desktop and is never sent to the server, so that a paired computer cannot change the keys the whole household uses. To set it up for everyone, enter it on the server. A desktop picks up a change at its next sync with the server, within five minutes. See [Desktop and server](../guides/desktop-and-server.md).

## What does Beacon send to AudioMuse-AI?

The ids of songs and artists (the songs a mix starts from, the queue so that nothing comes back twice, and the songs you skipped), what you typed into search, and the name of a mood or theme - nothing about you, and no password. The requests come from the Beacon server, or in the desktop app from the computer itself, and go only to the address you entered: running AudioMuse-AI at home, none of it leaves your network.
