# Folder source for Beacon

One of the example apps for Beacon's external sources, and a complete one: it is meant to be
run, not only read. It plays folders of music files in Beacon without
adding them to your media server. It shows up as its own tab in Beacon with albums,
artists, songs and search. Every song plays like any other, on the speakers too, and Beacon's
own queue does the rest, shuffle included.

Handy for a folder that does not belong in the library: imports not sorted yet, DJ sets,
recordings, a friend's hard drive.

![Albums](docs/albums.png)

## What it does

- Takes one folder or several. With several, each gets a tab at the top of the page, named
  after the folder, with its own albums, artists, songs and search.
- Reads every audio file below the folder, subfolders included, and groups them into
  albums: one album per folder and album tag. A compilation stays one album even when
  every song names another artist; `CD1`/`Disc 2` folders join their album.
- Looks like part of Beacon: its type, its colours (light themes too), its song table.
- Takes title, artist, album, track and disc number, year and genre from the tags, and the
  format with its bitrate, sample rate and bit depth from the file itself. A file
  without tags is named after its folders and file name (`Artist/Album/03 - Title.mp3`).
- Covers come from `cover.jpg`, `folder.jpg`, `front.jpg` (and `.png`, `.webp`) in the
  album folder, or from the cover embedded in a song.
- Looks for new music every 30 minutes, or when you press the refresh button. Only new
  and changed files are read again, so a large folder rescans in seconds. The first scan
  of a large folder takes a while; the page shows how many files are read and how many
  are still to go.
- Stays quick with a big folder: tens of thousands of songs are fine. Albums, artists
  and songs jump to a letter from the A-Z bar on the right, and the albums page opens on
  what was added last.
- Never writes to the music folder. Docker mounts it read-only.

Formats: MP3, AAC/M4A, FLAC, Ogg Vorbis, Opus, WAV and WebM audio.

![An album](docs/album.png)

## Running it

### Docker

There is a ready-made image, `ghcr.io/mihaitom/beacon-folder-source`, for x86 machines
and ARM ones like a Raspberry Pi. `latest` is the newest version; a version number
(`1.0.0`) stays on that version. It is not part of Beacon's own image.

#### Starting it

Save [`compose.yaml`](compose.yaml) on the server, set the music folder and a token in it,
then:

```bash
docker compose up -d
```

To update later:

```bash
docker compose pull && docker compose up -d
```

The index in `./data` stays.

#### A complete example

Two folders, each its own tab, with every setting written out:

```yaml
services:
  folder-source:
    image: ghcr.io/mihaitom/beacon-folder-source:latest
    container_name: beacon-folder-source
    restart: unless-stopped
    volumes:
      # Each folder under /music becomes a tab, named after its mount point.
      - /mnt/nas/music-imports:/music/Imports:ro
      - /mnt/nas/dj-sets:/music/DJ Sets:ro
      # The music index and the signing secret: keep this folder.
      - ./data:/data
    environment:
      # Mounting is not enough: list every folder here too, separated by ":".
      # Left out, the app takes all of /music as one folder, one tab.
      MUSIC_DIR: /music/Imports:/music/DJ Sets
      # The same token goes into Beacon, under Settings > Library > External sources.
      TOKEN: change-me
      # The name in the page's header, when it is opened outside Beacon.
      SOURCE_NAME: Music folder
      # How often to look for new music; 0: only at start and on the refresh button.
      RESCAN_MINUTES: 30
    ports:
      # Only Beacon's server has to reach this; do not forward it to the internet.
      - "8800:8800"
```

In Beacon the address is then `http://<this host>:8800`. When Beacon runs in the same
compose file on its default network (not with `network_mode: host`), it is
`http://folder-source:8800` instead, and `ports:` can go.

#### Building it yourself

Only needed to run changes of your own. A clone of Beacon's repository has the app at
`docs/examples/folder-source`. To fetch only this folder instead of all of Beacon:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/mihaitom/beacon.git
cd beacon
git sparse-checkout set docs/examples/folder-source
cd docs/examples/folder-source
```

In `compose.yaml`, replace the `image:` line with `build: .`, then:

```bash
docker compose up -d --build
```

To build on one machine and run on another, build the image under a name of your
choice, push it to a registry of your own and use that name as `image:`. A server with
another processor than the machine you build on needs the image for its platform:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t registry.example.com/you/folder-source:latest --push .
```

#### The data folder

`./data` holds the music index (`library.sqlite`) and the signing secret. Keep it: see
[Songs keep their identity](#songs-keep-their-identity). The container runs as uid 1000;
if your user has another uid, `chown 1000 data` once.

### Without Docker

Needs Python 3.13 and [uv](https://docs.astral.sh/uv/).

```bash
TOKEN=change-me uv run main.py /path/to/music /path/to/more/music
```

Each folder becomes a tab, named after the folder.

## Connecting Beacon

In Beacon: **Settings > Library > External sources > Add source**.

| Field       | Value                                               |
| ----------- | --------------------------------------------------- |
| Tab name    | Whatever the tab should be called, e.g. `Imports`   |
| Tab icon    | Any; a folder fits                                  |
| App address | `http://<host>:8800`, as Beacon's server reaches it |
| Token       | The `TOKEN` you set                                 |

"As Beacon's server reaches it" matters when Beacon runs in Docker: `localhost` there is
Beacon's own container. Use the host's address, or put both containers in one Docker
network and use `http://beacon-folder-source:8800`.

The speakers never talk to this app. They play from Beacon, which fetches from here.

Opening `http://<host>:8800/ui/` in a browser answers `Token required` while a token is
set. That is correct: only Beacon sends it. Without a token the page shows the library,
but can play only inside Beacon.

### Beacon behind a login (Authentik, Authelia, ...)

The page runs fenced off inside Beacon and cannot send your login cookie, so let the path
`/external-ui/` past the login, the same way as `/party/` for party mode. Beacon refuses
every request there that does not carry the random key it hands only to signed-in
listeners.

## Settings

All from the environment. The folders can also be given as arguments.

| Variable         | Default        | What it does                                                 |
| ---------------- | -------------- | ------------------------------------------------------------ |
| `MUSIC_DIR`      | -              | The folder to serve; several separated by `:`. See below     |
| `TOKEN`          | none           | Beacon has to send it to see the page. Set one               |
| `SOURCE_NAME`    | `Music folder` | The name shown in the page's header                          |
| `RESCAN_MINUTES` | `30`           | How often to look for new music; `0`: at start and on demand |
| `DATA_DIR`       | `./data`       | Music index and secret (in Docker: `/data`)                  |
| `SECRET`         | made once      | Signs song addresses. Leave it unset unless you run copies   |
| `HOST`, `PORT`   | `0.0.0.0:8800` | Where to listen                                              |

### Several folders

Each folder is a tab, named after the folder itself. In Docker that is the name it is
mounted under, so the mount point is where you choose it:

```yaml
volumes:
  - /srv/imports:/music/Imports:ro
  - /srv/dj-sets:/music/DJ Sets:ro
environment:
  MUSIC_DIR: /music/Imports:/music/DJ Sets
```

Mounting a folder under `/music` without listing it in `MUSIC_DIR` leaves it out of the
tabs (and `MUSIC_DIR` left at `/music` makes everything one tab). There is a whole
`compose.yaml` under [A complete example](#a-complete-example). The tabs keep the order of
`MUSIC_DIR`. Two folders of the same name are refused at start:
mount one under another name. Search looks only in the folder whose tab is open.

## Security

- **The page and its API** (`/v1`, `/ui/...`) answer only with the token. Beacon adds it
  when it passes the page through; the page itself never sees it.
- **Songs and covers** are fetched by Beacon without any header, so their addresses carry
  a signature instead. Without it, nothing is served. A file cannot be named by its path:
  the app serves only what it indexed, and a symlink that leads out of the folder is
  skipped.
- `/health` answers anybody, with nothing but `{"ok": true}`.

A song address does not expire: Beacon keeps it to play the song again from the history.
Anyone who has one can play that one song. Keep the port internal and do not forward it
to the internet; only Beacon's server needs to reach it.

### Songs keep their identity

Beacon tells songs apart by their address, and the address comes from the file's place in
the folder, its name and the secret. Moving or renaming a file makes it a new song to Beacon,
and so does renaming its folder (in Docker: its mount point) or a new secret: delete
`data/secret` and every song played so far is a stranger.

## Development

```bash
uv sync
uv run pytest                     # needs ffmpeg, to make the test songs
uv run ruff format . && uv run ruff check .
```

The page is plain HTML, CSS and JavaScript in `folder_source/ui/`, no build step. Inter,
the typeface Beacon is set in, comes along in `ui/fonts/` under its own licence. Anything
the page loads itself has to live below `/ui/`, because Beacon passes only that part
through. Song and cover addresses handed to Beacon may point anywhere on this app.

How Beacon and the page talk to each other is in Beacon's help, under **External source
API** ([`docs/help/reference/external-source-api.md`](../../help/reference/external-source-api.md)).
The tests run in Beacon's CI too, whenever something in this folder changes. The image is
published by hand, from Beacon's repository; a new `version` in `pyproject.toml` gives it a
new version tag.
