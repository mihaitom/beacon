---
group: connecting
order: 5
---

# External sources

## What is an external source?

An app you run yourself that brings songs your library does not have. Beacon
shows the app's own page as a tab, and when you pick a song there, Beacon plays
it like any other: on this device, or cast to your speakers.

Beacon does not come with such an app and does not recommend one. What the app
offers and where its audio comes from is entirely up to whoever runs it. Only
use sources you are allowed to play.

## What could it be?

- A folder of music that is not in your library, or a second music server
- Recordings of your own, a choir's rehearsals, a band's demos
- A request list where others suggest songs, and you play the ones you like
- A shop or a service you pay for, if it gives you the files

## How do I set it up?

1. Run the app somewhere Beacon can reach it: on the same machine, or on a
   computer in your network.
2. In Beacon, open Settings > Library > External sources and choose **Add
   source**. Give the tab a name and an icon, enter the app's address (for
   example `http://192.168.1.20:8800`) and, if the app asks for one, its token.
3. Save. Beacon checks the connection right away and says whether the app
   answered.

Each app is a source of its own with its own tab, up to twelve. A click on one
in the list changes or removes it.

On a Beacon server only an administrator can set sources up, and they are the
same for everyone signed in. In the desktop app they are yours alone.

## Is the token a key from Apps and devices?

No, it goes the other way. A key from Apps and devices lets an app into Beacon.
The token here lets Beacon into your app: you choose it in your app's settings
and enter the same value in Beacon, which sends it along whenever it fetches
the app's page. An app that does not ask for one needs none.

It keeps others on your network from opening the app's page directly. It does
not encrypt anything; for that the app needs an `https://` address.

## Where do I find the tab?

On the desktop, in the sidebar under the name and icon you gave it. On a
phone, open Radio: the button next to Discover leads there, or with several
sources, a menu of them.

## What works with these songs?

Almost everything a library song can do: playing, the queue, casting to every
kind of speaker, lyrics, the visualizer and lights, and the listening history.
Seeking, the waveform and transitions need the app to send its audio in a way
that allows jumping around (see [the API](../reference/external-source-api.md)).
Without that a song still plays, from start to end, like a radio station.

What does not work: favourites, ratings and playlists. Those live on your media
server, and it knows nothing about these songs. Party guests cannot pick them
either.

## Is it safe to show another app's page inside Beacon?

The page runs fenced off. It cannot see your library, your login or anything
else of Beacon's; it cannot store anything in your browser; and it cannot leave
the tab. All it can do is ask Beacon to play a song, and Beacon fetches that
song only from the app's own address, never from anywhere else the page names.
In return, Beacon tells the page only its colours and what is playing.

Still: only add an app you trust. Its page runs in your browser.

## Beacon is behind a login (Authentik, Authelia, ...). The tab stays empty.

The fenced-off page cannot send your login cookie along with its own requests,
so your reverse proxy redirects them to the login page. Let the path
`/external-ui/` past the login, the same way as `/party/` for party mode. It is
safe to do: without the long random part that follows it, which Beacon hands
only to signed-in listeners, every request there is refused.

## How do I write such an app?

Settings > Library > External sources has a button **Copy instructions for
an AI**. Paste them into an AI assistant and say what your app should do; they hold
everything it needs to know about Beacon. The full description, with a small
working example, is [the external source API](../reference/external-source-api.md).

Plan the phone from the start. There the tab gets only the space between
Beacon's bars, and a page that looks right on the desktop is far too big in it.
The API page says what helps.

## Something does not work

- **"Not reachable"** after saving: the address is wrong, or Beacon cannot reach
  that machine. A Beacon server in Docker cannot reach `localhost` of the
  computer it runs on; use its network address.
- **The tab shows the app's error page**: the app answered, but not at `/ui/`.
- **A song does not start**: the audio address must belong to the app itself.
  Beacon refuses audio from anywhere else and says so in a message.
- **Songs from earlier no longer play**: the app stopped serving their audio.
  Ask it to keep its audio addresses working for at least a day. Songs from a
  source that was removed in Beacon do not play any more either.
