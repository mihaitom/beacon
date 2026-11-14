# Live Music Archive for Beacon

One of the example apps for Beacon's external sources, and the one that shows an online
source works too. It plays concerts from the
[Live Music Archive](https://archive.org/details/etree) at archive.org in
[Beacon](https://github.com/mihaitom/beacon): over 250,000 recordings of live shows by
bands that allow their concerts to be taped and shared. It shows up as its own tab in
Beacon. Every song plays like any other, on the speakers too, and Beacon's own queue does
the rest.

## What it does

- **Shows**: the most played concert of the week, large; shows played on this day in
  other years; the shows listeners rated best; and the rest of the week's most played.
  Each list keeps one recording per night and only a few shows per artist.
- **Artists**: the most played artists, and every other one by search. Each wears the
  picture archive.org has for the band, in Beacon's player too.
- An artist's shows, newest, oldest or most played first, 50 at a time. A night often has
  several recordings; each row says how it was taped, as the taper wrote it
  (`SBD -> DAT`, `Schoeps MK4 > ...`).
- Search finds artists, and shows by venue, city, artist or date.
- A show plays as one album, `1977-05-08 - Barton Hall`, in the order of the recording.
  It plays the MP3 copies archive.org makes of every show, or the FLAC original when a
  show has nothing else.
- The show's page on archive.org is one tap away, with the taper's notes.

### What it leaves out

Some bands allow their shows to be streamed on archive.org but not downloaded. The
archive keeps those apart and marks them, and this app never offers them: they are left
out of every list and search, and their audio is refused even when asked for directly.
Everything else in the Live Music Archive is free to download for non-commercial use;
the artists keep their copyright. Do not use this app to sell or republish what it plays.

### How it treats archive.org

- It says who it is in every request, as archive.org asks automated clients to.
- It keeps answers instead of asking again: searches for 10 minutes, shows for an hour,
  pictures for a day, all in memory. Audio is passed on as it arrives and never kept.
- When archive.org asks it to slow down, it stops asking for as long as told.

## Running it

It needs no music of its own, only a way out to archive.org.

### Docker

There is no ready-made image: you build it yourself from this folder. It is not part of
Beacon's own image either.

#### Getting the folder

A clone of Beacon's repository has it at `docs/examples/live-music-archive`. To fetch
only this folder instead of all of Beacon:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/mihaitom/beacon.git
cd beacon
git sparse-checkout set docs/examples/live-music-archive
cd docs/examples/live-music-archive
```

#### Building and running on the same machine

Set a token in `compose.yaml`, then:

```bash
docker compose up -d --build
```

Compose builds the image and starts it. To update later, `git pull` and run the same
command again.

#### Building for another machine

Build the image with a name of your choice:

```bash
docker build -t live-music-archive:1.0.0 .
```

Then get it to the server one of two ways:

- **Through a registry of your own**: tag and push it, and in the server's
  `compose.yaml` replace `build: .` with `image:` and that name.

  ```bash
  docker tag live-music-archive:1.0.0 registry.example.com/you/live-music-archive:latest
  docker push registry.example.com/you/live-music-archive:latest
  ```

- **Without a registry**: copy it straight over SSH, and use
  `image: live-music-archive:1.0.0` in the server's `compose.yaml`.

  ```bash
  docker save live-music-archive:1.0.0 | ssh server docker load
  ```

A server with another processor than the machine you build on, a Raspberry Pi built for
on a PC say, needs the image for its platform:
`docker buildx build --platform linux/arm64 -t registry.example.com/you/live-music-archive:latest --push .`

#### The data folder

`./data` holds only the signing secret. Keep it: see
[Songs keep their identity](#songs-keep-their-identity). The container runs as uid 1000;
if your user has another uid, `chown 1000 data` once.

### Without Docker

Needs Python 3.13 and [uv](https://docs.astral.sh/uv/).

```bash
TOKEN=change-me uv run main.py
```

## Connecting Beacon

In Beacon: **Settings > Library > External sources > Add source**.

| Field       | Value                                               |
| ----------- | --------------------------------------------------- |
| Tab name    | Whatever the tab should be called, e.g. `Live`      |
| Tab icon    | Any; the microphone or the cassette fits            |
| App address | `http://<host>:8801`, as Beacon's server reaches it |
| Token       | The `TOKEN` you set                                 |

"As Beacon's server reaches it" matters when Beacon runs in Docker: `localhost` there is
Beacon's own container. Use the host's address, or put both containers in one Docker
network and use `http://beacon-live-music-archive:8801`.

The speakers never talk to this app, and Beacon never talks to archive.org. The speakers
play from Beacon, Beacon fetches from this app, and this app from archive.org.

Opening `http://<host>:8801/ui/` in a browser answers `Token required` while a token is
set. That is correct: only Beacon sends it. Without a token the page shows the archive,
but can play only inside Beacon.

### Beacon behind a login (Authentik, Authelia, ...)

The page runs fenced off inside Beacon and cannot send your login cookie, so let the path
`/external-ui/` past the login, the same way as `/party/` for party mode. Beacon refuses
every request there that does not carry the random key it hands only to signed-in
listeners.

## Settings

All from the environment.

| Variable       | Default              | What it does                                               |
| -------------- | -------------------- | ---------------------------------------------------------- |
| `TOKEN`        | none                 | Beacon has to send it to see the page. Set one             |
| `SOURCE_NAME`  | `Live Music Archive` | The name shown in the page's header                        |
| `DATA_DIR`     | `./data`             | The signing secret (in Docker: `/data`)                    |
| `SECRET`       | made once            | Signs song addresses. Leave it unset unless you run copies |
| `HOST`, `PORT` | `0.0.0.0:8801`       | Where to listen                                            |

## Security

- **The page and its API** (`/v1`, `/ui/...`) answer only with the token. Beacon adds it
  when it passes the page through; the page itself never sees it.
- **Songs and covers** are fetched by Beacon without any header, so their addresses carry
  a signature instead. Without it, nothing is fetched from archive.org. A signed address
  still gets only a song of a show that may be played here: the app is no open door to
  archive.org.
- Nothing typed into the search can change what the app asks archive.org for beyond
  the search itself, and an archive.org name that does not look like one is refused
  before anything is asked.
- `/health` answers anybody, with nothing but `{"ok": true}`.

A song address does not expire: Beacon keeps it to play the song again from the history.
Anyone who has one can play that one song through this app. Keep the port internal and
do not forward it to the internet; only Beacon's server needs to reach it.

### Songs keep their identity

Beacon tells songs apart by their address, and the address comes from the show, the file
and the secret. Delete `data/secret` and every song played so far is a stranger to
Beacon.

## Development

```bash
uv sync
uv run pytest                     # no internet needed: archive.org is played by the tests
uv run ruff format . && uv run ruff check .
```

The page is plain HTML, CSS and JavaScript in `live_music_archive/ui/`, no build step.
Anything the page loads itself has to live below `/ui/`, because Beacon passes only that
part through; that is why pictures come through `/ui/images/` and not from archive.org.
Song and cover addresses handed to Beacon may point anywhere on this app.

How Beacon and the page talk to each other is in Beacon's help, under **External source
API** ([`docs/help/reference/external-source-api.md`](../../help/reference/external-source-api.md)).
The tests run in Beacon's CI too, whenever something in this folder changes.
