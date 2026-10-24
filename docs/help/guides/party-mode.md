---
order: 2
---

# Party mode

Guests open a link or scan a QR code and get a page of their own in the app's
look: Now Playing as the app shows it with the artwork hidden - the artist's
Fanart.tv background, the song in a card in the bottom-left corner, the
lyrics beside it (on a phone, on the back of the card, as in the mobile
app). The large cover, the lyrics and the visualizer are each a toggle the
guest's device remembers; without an artist background the large cover shows
on its own. The artist background is only darkened behind the large cover,
a guest can step through the artist's backgrounds, and the page's accent
colour follows the picture as in the app. A radio station shows with its
logo and the title it is currently playing. On a computer, what's next and the
search sit in a side panel; on a phone,
the mobile layout with a tab bar. The lyrics are the host's, with the match
and sync offset the host chose, and while the host casts, the visualizer runs
on the guests' screens too. They cannot pause, skip on their own, reorder or
remove anything, pick a speaker or change the volume. The host starts it from
the party button in the player bar, in the desktop app and in the web build
alike.

Guests on the same Wi-Fi need nothing but the QR code. For guests from
anywhere else, and for an online party, Beacon has to be reachable from the
internet: [Party mode over the internet](party-over-the-internet.md) covers
the setup and what keeps the rest of Beacon closed.

## What a guest can do

| Can                                                | Cannot                                     |
| -------------------------------------------------- | ------------------------------------------ |
| See the current song and the next 100 in the queue | Control playback, volume or speakers       |
| Search songs and albums and wish for a song        | Remove or move anything but their own wish |
| Withdraw their own wish until it starts playing    | See who other guests are beyond a name     |
| Vote to skip the current song                      | Reach anything outside `/party/`           |
| Listen in their browser, when the host allows it   | Hear anything but what the host hears      |

Wishes go into a block right after the current song, taking turns between
guests: three wishes from Anna and then one from Ben play as Anna, Ben, Anna,
Anna. Each guest has a limit of open wishes (default 3), and a song already
wished for can't be wished for twice. A song that is coming up anyway is moved
forward to where the wish would go instead of being queued a second time, and
stays put if it comes sooner than that. A skip needs the chosen share of the
guests who have the page open (default half), rounded up: with a third and a
single guest, that guest's vote is enough. The host skips with the app's own
controls.

While a radio station plays there is no queue to wish into: what's next and
the search make way for a note saying so, and a wish that arrives anyway is
refused.

## Online party

For a group that meets online rather than in one room - friends in a voice
chat, a stream, a remote team's Friday call - where the host brings the
music. With "Online party" switched on in the party dialog, everyone opens
the party link and gets the music in their own browser, along with
everything else a party has: what's coming up, wishes, skip votes, lyrics.
The host picks the quality there (AAC at 128, 192 or 256 kbit/s); it is off
until then. Guests then get a player bar of their own along the bottom of
the page: a play button that starts and stops their stream, a waveform
showing where the song is, and their own volume, which changes only what
their browser plays (on a computer; a phone has its buttons for that, and an
iPhone lets no page set it). The stream is what the host plays: the songs
while the host casts or plays locally, and a radio station too. Nothing
changes for the host, who listens as always.

The online party is a web build feature (the Docker image, reached under its
public address). It needs Beacon behind a reverse proxy, reachable from
the internet - see [Party mode over the internet](party-over-the-internet.md)
for what that takes and setups for the common proxies. The desktop app's party link is
this machine's LAN address, which nobody outside the room can reach, so its
party dialog does not offer it.

Everyone listening online is a few seconds behind the host - the buffer
that carries a phone through a dead spot on mobile data - and the guests are
roughly, not exactly, in step with each other. In a voice chat that shows
when somebody reacts to a song: the host hears the moment first, the others
a few seconds later. The song card, the lyrics and the visualizer follow
what each guest hears, not what the host hears, so they stay with the music;
what's next, the search and the skip vote stay live. The visualizer works
even while the host plays locally.

Each listener costs upload bandwidth on the Beacon server: about the chosen
bitrate per guest, so ten guests at 192 kbit/s are around 2 Mbit/s. The
party dialog shows how many are listening and roughly what that adds up to.

Streaming a music library over the internet to people outside the household
is legally a different thing from playing it to friends in one room. Whether
that is fine where you live is your decision. The same goes for your proxy
or CDN: a free CDN plan (Cloudflare's, for example) may not allow continuous
audio through it, so check its terms or serve the party from a hostname
that bypasses the CDN.

## Things to know

- The party runs in the window that started it. In the web build, another
  browser tab can take it over from the party dialog, and only one tab answers
  guests at a time: the one that gave it up lets go within about ten seconds.
  When that window goes quiet - closed, or asleep - the party ends after about
  a minute and a half, unless the host is casting. Then the Beacon server
  keeps the party going and shows guests what plays while that window sleeps
  (a locked phone) or, in the web build, after the tab is closed. Guests keep
  searching, wishing, withdrawing and voting to skip then: the server answers
  them itself, out of the music server and the cast's own queue, and the
  window takes the wishes back if the cast ends while it is open. While the
  host casts, the server also looks up the lyrics and the artist background on
  its own, so a new song needs nothing from the sleeping window; those lyrics
  are the server's automatic match, without the sync offset the host may have
  chosen, and the host's own copy returns once the window wakes. The party
  dialog says which path is in effect. Quitting the desktop app stops its
  Beacon server, and the party with it. See
  [plans/party-mode-server-side.md](../../plans/party-mode-server-side.md).
- Taking a party over, or reloading the window that hosts it, keeps the link:
  the window gets it back from the Beacon server, and guests already there
  stay in. Only "Renew link" makes a new one and signs everyone out.
- A wish is an ordinary queue entry. The host can move or remove it like any
  other, and that is what the guests then see.
