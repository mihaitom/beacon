---
group: connecting
order: 6
---

# External source API

What an app needs to offer to work as an [external source](../faq/external-sources.md):
a page for Beacon's tab, and audio behind addresses of its own. Beacon shows the
page and plays what it hands over; it never looks at how the app finds its
songs.

## The app's address

Everything lives under one base address, the one entered in Beacon's settings,
for example `http://192.168.1.20:8800`. Beacon needs:

| Path      | What                                                                   |
| --------- | ---------------------------------------------------------------------- |
| `GET /v1` | `{"name": "...", "version": "...", "capabilities": []}` as JSON        |
| `/ui/...` | the tab: `GET /ui/` returns the page, plus its scripts, styles and API |
| anywhere  | the audio files and covers, at addresses the page chooses              |

Beacon calls `/v1` when the settings are saved, to say whether the app
answered. `capabilities` is for later versions; send an empty list.

### The token

The app defines the token, if it wants one, and the listener enters the same
value in Beacon. It is unrelated to the keys under Apps and devices, which let
apps call Beacon. If a token is set, every request Beacon passes on to `/v1`
and `/ui/` carries `Authorization: Bearer <token>`. Audio and cover requests do not: an app
that wants to protect them puts an unguessable or signed part into their
addresses.

## The page

Beacon does not show the page from the app's address directly. It passes
`/ui/` through its own server, so the tab works on a phone away from home and
under https. Two consequences:

- **Use relative addresses only**: `app.js`, `api/search?q=x`. Not
  `/ui/app.js`, not `http://...`. The page is served from somewhere else than
  the app's address, and only relative ones follow it there.
- **The page's own requests** (`fetch('api/search?q=x')`) arrive at the app as
  `/ui/api/search?q=x`, with the method, the body and the `Content-Type` they
  were sent with.
- **Everything the page loads itself lives under `/ui/`**, its pictures too.
  `../` leads out of what Beacon passes through and ends in a 404. Only
  addresses the page hands to Beacon (`audioUrl`, `coverUrl`) may point
  elsewhere on the app's address, since Beacon fetches those itself.

The page runs sandboxed, with an origin of its own that is not Beacon's:

- no cookies, no `localStorage`, no `sessionStorage`, no IndexedDB: keep state
  in memory, or in the app
- no navigating the window Beacon runs in; links with `target="_blank"` open
  in a new window
- no camera, microphone or the like

It is shown full size in the tab, and on a phone at phone width: build it to
cope with both.

## Messages

The page and Beacon talk with `postMessage`.

### From the page

```js
window.parent.postMessage({ type: 'beacon.ready' }, '*')

window.parent.postMessage(
  {
    type: 'beacon.play',
    mode: 'now', // 'now' | 'next' | 'queue'
    item: {
      audioUrl: '../audio/42.m4a', // required
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      coverUrl: '../covers/42.jpg',
      duration: 215, // seconds
    },
  },
  '*',
)
```

- `beacon.ready` once the page is set up, to get the messages below.
- `beacon.play`: `now` replaces the queue and plays, `next` plays it after the
  current song, `queue` adds it at the end.
- `audioUrl` and `coverUrl` are relative to `/ui/` (`../audio/42.m4a` is
  `<base>/audio/42.m4a`), or absolute on the app's own address. **Beacon refuses
  any other address**, so a page cannot make it fetch from anywhere else.
- Only `audioUrl` is required. Without the rest the player shows "Unknown".

### From Beacon

```js
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  const message = event.data
  // ...
})
```

| `type`              | Sent                              | Content                                                                                                                                         |
| ------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `beacon.theme`      | after `beacon.ready`, on a change | `dark` (boolean), `colors` (`background`, `surface`, `on-background`, `on-surface`, `primary`, `on-primary`, `secondary`, `error` as `#rrggbb`) |
| `beacon.nowPlaying` | after `beacon.ready`, on a change | `item`: `{title, artist, album}` or `null`                                                                                                      |
| `beacon.played`     | after every `beacon.play`         | `ok` (boolean), `error` (text) when not ok                                                                                                      |

The colours let a page look like part of Beacon. Using them is up to the page.

## Audio

Beacon fetches the audio itself, from its server, as often as it needs to: to
play it, for every speaker it is cast to, for the waveform, and after a reload.

- **Send `Content-Length` and answer `Range` requests** (`206 Partial
Content`). Then a song can be seeked, gets a waveform and can go into a
  transition. Without them it still plays, from start to end.
- **Formats**: MP3, AAC/M4A, Opus or Vorbis in WebM/Ogg, FLAC and WAV all play
  everywhere; Beacon converts for speakers that need it.
- **Keep addresses working for at least a day**, so a queue restored later
  still plays. A song keeps its place in Beacon's queue by its `audioUrl`.
- **No redirects**: Beacon does not follow them.

## A complete example

Your music folder as albums, with covers, search, "play album", play next and
add to queue, the song that is playing marked, and Beacon's colours. Every
folder with music in it is an album; a layout of `Artist/Album/` gives the songs
their artist and album, and a `cover.jpg` or `folder.jpg` in the folder its
cover. Python 3, nothing to install:

```sh
python3 folder_source.py /path/to/music
```

Then enter `http://<this computer>:8800` in Beacon (another port:
`PORT=9000 python3 ...`).

```python
#!/usr/bin/env python3
"""An example external source for Beacon: the music in a folder and its
subfolders, shown as albums. Python 3, nothing to install."""

import json
import mimetypes
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote

FOLDER = os.path.realpath(sys.argv[1] if len(sys.argv) > 1 else ".")
PORT = int(os.environ.get("PORT", 8800))
AUDIO = (".mp3", ".m4a", ".flac", ".ogg", ".opus", ".wav", ".webm")
COVERS = ("cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "front.png")
TRACK_NUMBER = re.compile(r"^(\d{1,3})[\s._-]+")

PAGE = r"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  :root { --bg: #121417; --fg: #e8e8ea; --surface: #1c1f24; --primary: #f5a94e;
          --on-primary: #1a1a1a; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 15px/1.4 system-ui, sans-serif;
         background: var(--bg); color: var(--fg); }
  header { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 24px; margin: 0; flex: 1; }
  input { padding: 10px 14px; border-radius: 999px; border: 0; min-width: 0; width: 240px;
          background: var(--surface); color: inherit; font: inherit; }
  .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .album { cursor: pointer; border: 0; padding: 0; background: none; color: inherit;
           text-align: left; font: inherit; }
  .cover { aspect-ratio: 1; border-radius: 10px; overflow: hidden; display: grid;
           place-items: center; font-size: 42px; font-weight: 700; color: #fff8;
           box-shadow: 0 6px 18px #0006; transition: transform .2s; }
  .cover img { width: 100%; height: 100%; object-fit: cover; }
  .album:hover .cover { transform: translateY(-4px) scale(1.02); }
  .name { margin-top: 8px; font-weight: 600; white-space: nowrap; overflow: hidden;
          text-overflow: ellipsis; }
  .sub { opacity: .65; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hero { display: flex; gap: 24px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 20px; }
  .hero .cover { width: 200px; font-size: 64px; }
  .hero h2 { font-size: 30px; margin: 4px 0; }
  .pill { border: 0; border-radius: 999px; padding: 10px 20px; font: inherit; font-weight: 600;
          cursor: pointer; background: var(--primary); color: var(--on-primary); }
  .ghost { background: var(--surface); color: inherit; }
  .row { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: 8px; }
  .row:hover { background: var(--surface); }
  .row.playing { color: var(--primary); font-weight: 600; }
  .num { width: 24px; text-align: right; opacity: .6; font-variant-numeric: tabular-nums; }
  .title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row button { border: 0; background: none; color: inherit; cursor: pointer; padding: 6px;
                border-radius: 50%; opacity: .7; display: grid; }
  .row button:hover { opacity: 1; background: var(--bg); }
  svg { width: 20px; height: 20px; fill: currentColor; }
  .bars { display: inline-flex; gap: 2px; align-items: flex-end; height: 14px; width: 24px;
          justify-content: flex-end; }
  .bars i { width: 3px; background: var(--primary); animation: bar .9s infinite ease-in-out alternate; }
  .bars i:nth-child(2) { animation-delay: -.3s; } .bars i:nth-child(3) { animation-delay: -.6s; }
  @keyframes bar { from { height: 20%; } to { height: 100%; } }
  #toast { position: fixed; left: 50%; bottom: 20px; transform: translate(-50%, 80px);
           background: var(--surface); padding: 10px 18px; border-radius: 999px;
           box-shadow: 0 6px 18px #0008; transition: transform .25s; }
  #toast.show { transform: translate(-50%, 0); }
  @media (max-width: 500px) {
    body { padding: 14px; } input { width: 100%; }
    .grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .hero .cover { width: 140px; }
  }
</style></head>
<body><div id="app"></div><div id="toast"></div>
<script>
  const ICONS = {
    play: '<path d="M8 5v14l11-7z"/>',
    next: '<path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z"/>',
    queue: '<path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm16-1v-3h-2v3h-3v2h3v3h2v-3h3v-2z"/>',
    back: '<path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/>',
  }
  const icon = (name) => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`
  const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const app = document.getElementById('app')
  let albums = [], query = '', open = null, nowPlaying = null

  // One colour per album for those without a cover, the same every time.
  function tint(text) {
    let hash = 0
    for (const c of text) hash = (hash * 31 + c.charCodeAt(0)) | 0
    const hue = Math.abs(hash) % 360
    return `linear-gradient(135deg, hsl(${hue} 55% 45%), hsl(${(hue + 50) % 360} 60% 28%))`
  }
  const cover = (album) => album.cover
    ? `<div class="cover"><img src="covers/${album.path}" alt=""></div>`
    : `<div class="cover" style="background:${tint(album.title)}">${esc(album.title[0] || '?')}</div>`

  // Beacon answers every beacon.play with beacon.played: waiting for it keeps
  // an album in order, since Beacon handles each request on its own.
  let answered = null
  function play(album, track, mode) {
    return new Promise((resolve) => {
      answered = resolve
      parent.postMessage({ type: 'beacon.play', mode, item: {
        audioUrl: '../audio/' + track.path, title: track.title,
        artist: album.artist, album: album.title, duration: track.duration,
        coverUrl: album.cover ? 'covers/' + album.path : undefined,
      } }, '*')
    })
  }
  async function playAlbum(album) {
    for (const [i, track] of album.tracks.entries()) {
      const result = await play(album, track, i === 0 ? 'now' : 'queue')
      if (!result.ok) break
    }
    toast(`Playing ${album.title}`)
  }

  function toast(text) {
    const el = document.getElementById('toast')
    el.textContent = text
    el.classList.add('show')
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => el.classList.remove('show'), 2200)
  }

  const songs = (album) => `${album.tracks.length} song${album.tracks.length === 1 ? '' : 's'}`
  const isPlaying = (album, track) => nowPlaying
    && nowPlaying.title === track.title && nowPlaying.album === album.title

  function render() {
    if (open) {
      const album = open
      app.innerHTML = `
        <header><button class="pill ghost" data-back>${icon('back')}</button></header>
        <div class="hero">${cover(album)}<div>
          <div class="sub">${esc(album.artist || 'Album')}</div><h2>${esc(album.title)}</h2>
          <div class="sub">${songs(album)}</div><br>
          <button class="pill" data-album>Play album</button></div></div>
        ${album.tracks.map((t, i) => `
          <div class="row ${isPlaying(album, t) ? 'playing' : ''}">
            ${isPlaying(album, t) ? '<span class="bars"><i></i><i></i><i></i></span>'
                                  : `<span class="num">${t.number ?? i + 1}</span>`}
            <span class="title">${esc(t.title)}</span>
            <button title="Play" data-track="${i}" data-mode="now">${icon('play')}</button>
            <button title="Play next" data-track="${i}" data-mode="next">${icon('next')}</button>
            <button title="Add to queue" data-track="${i}" data-mode="queue">${icon('queue')}</button>
          </div>`).join('')}`
      return
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const shown = albums.filter((a) => words.every((w) =>
      `${a.title} ${a.artist} ${a.tracks.map((t) => t.title).join(' ')}`.toLowerCase().includes(w)))
    app.innerHTML = `
      <header><h1>Music folder</h1>
        <input id="search" placeholder="Search" value="${esc(query)}"></header>
      <div class="grid">${shown.map((a) => `
        <button class="album" data-open="${albums.indexOf(a)}">${cover(a)}
          <div class="name">${esc(a.title)}</div>
          <div class="sub">${esc(a.artist || songs(a))}</div></button>`).join('')}
      </div>`
    const search = document.getElementById('search')
    search.oninput = () => { query = search.value; render(); restoreFocus() }
  }
  function restoreFocus() {
    const search = document.getElementById('search')
    search.focus()
    search.setSelectionRange(query.length, query.length)
  }

  app.addEventListener('click', (event) => {
    const el = event.target.closest('button')
    if (!el) return
    if (el.dataset.open) { open = albums[el.dataset.open]; render(); scrollTo(0, 0) }
    else if (el.dataset.back !== undefined) { open = null; render() }
    else if (el.dataset.album !== undefined) playAlbum(open)
    else if (el.dataset.track) {
      const track = open.tracks[el.dataset.track]
      play(open, track, el.dataset.mode).then((r) => r.ok && el.dataset.mode !== 'now'
        && toast(el.dataset.mode === 'next' ? `${track.title} plays next` : `Added ${track.title}`))
    }
  })

  addEventListener('message', (event) => {
    if (event.source !== parent) return
    const message = event.data
    if (message.type === 'beacon.played') {
      if (!message.ok) toast(message.error || 'Could not play that')
      answered?.(message)
      answered = null
    } else if (message.type === 'beacon.nowPlaying') {
      nowPlaying = message.item
      if (open) render()
    } else if (message.type === 'beacon.theme') {
      const c = message.colors, s = document.documentElement.style
      s.setProperty('--bg', c.background); s.setProperty('--fg', c['on-background'])
      s.setProperty('--surface', c.surface); s.setProperty('--primary', c.primary)
      s.setProperty('--on-primary', c['on-primary'])
      s.colorScheme = message.dark ? 'dark' : 'light'
    }
  })

  fetch('api/library').then((r) => r.json()).then((list) => { albums = list; render() })
  parent.postMessage({ type: 'beacon.ready' }, '*')
</script></body></html>"""


def library():
    """One album per folder that holds music. Artist/Album/ gives both names."""
    albums = []
    for root, dirs, names in os.walk(FOLDER):
        dirs.sort()
        tracks = []
        for name in sorted(names):
            if not name.lower().endswith(AUDIO):
                continue
            stem = os.path.splitext(name)[0]
            number = TRACK_NUMBER.match(stem)
            tracks.append({
                "path": quote(os.path.relpath(os.path.join(root, name), FOLDER).replace(os.sep, "/")),
                "title": TRACK_NUMBER.sub("", stem) or stem,
                "number": int(number.group(1)) if number else None,
            })
        if not tracks:
            continue
        folder = os.path.relpath(root, FOLDER).replace(os.sep, "/")
        parts = [] if folder == "." else folder.split("/")
        albums.append({
            "path": quote("" if folder == "." else folder),
            "title": parts[-1] if parts else "Loose songs",
            "artist": parts[-2] if len(parts) > 1 else "",
            "cover": any(os.path.isfile(os.path.join(root, c)) for c in COVERS),
            "tracks": tracks,
        })
    return albums


def inside(relative):
    """The path in the folder, or None. realpath catches "../" and symlinks."""
    path = os.path.realpath(os.path.join(FOLDER, relative))
    return path if path == FOLDER or path.startswith(FOLDER + os.sep) else None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/v1":
            self.send_body(json.dumps({"name": "Music folder", "version": "2", "capabilities": []}),
                           "application/json")
        elif path == "/ui/":
            self.send_body(PAGE, "text/html; charset=utf-8")
        elif path == "/ui/api/library":
            self.send_body(json.dumps(library()), "application/json")
        elif path.startswith("/ui/covers/"):
            # Under /ui/: the page shows these itself, and only /ui/ reaches it.
            folder = inside(unquote(path[len("/ui/covers/"):]))
            candidates = [os.path.join(folder, c) for c in COVERS] if folder else []
            self.send_file(next((c for c in candidates if os.path.isfile(c)), None))
        elif path.startswith("/audio/"):
            file = inside(unquote(path[len("/audio/"):]))
            self.send_file(file if file and file.lower().endswith(AUDIO) else None)
        else:
            self.send_error(404)

    def send_body(self, text, content_type):
        body = text.encode()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, file):
        """The file, with Range support: Beacon can then seek in it."""
        if not file or not os.path.isfile(file):
            return self.send_error(404)
        size = os.path.getsize(file)
        start, end = 0, size - 1
        ranged = self.headers.get("Range", "").startswith("bytes=")
        if ranged:
            first, _, last = self.headers["Range"][6:].split(",")[0].partition("-")
            if first:
                start, end = int(first), int(last) if last else size - 1
            else:
                start = max(0, size - int(last))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                return self.end_headers()
        self.send_response(206 if ranged else 200)
        self.send_header("Content-Type", mimetypes.guess_type(file)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if ranged:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(file, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


if __name__ == "__main__":
    print(f"Serving {FOLDER} on port {PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
```

## Letting an AI write it

Settings > Library > External source > **Copy instructions for an AI** copies
a prompt with everything above that matters for writing an app. Add what the
app should do and in which language.
