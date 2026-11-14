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

If a token is set in Beacon, every request Beacon passes on to `/v1` and `/ui/`
carries `Authorization: Bearer <token>`. Audio and cover requests do not: an app
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

A page that lists the audio files in a folder and plays them. Python 3,
nothing to install: `python3 folder_source.py /path/to/music`, then enter
`http://<this computer>:8800` in Beacon.

```python
#!/usr/bin/env python3
"""A minimal external source for Beacon: the audio files in one folder."""

import json
import mimetypes
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote

FOLDER = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
AUDIO = (".mp3", ".m4a", ".flac", ".ogg", ".opus", ".wav", ".webm")

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  body { font: 15px system-ui, sans-serif; margin: 16px; background: var(--bg); color: var(--fg); }
  button { display: block; width: 100%; text-align: left; padding: 10px; margin: 4px 0;
           border: 0; border-radius: 8px; background: var(--surface); color: inherit; cursor: pointer; }
  button:hover { outline: 2px solid var(--primary); }
</style></head>
<body><h2>Folder</h2><div id="list"></div>
<script>
  const list = document.getElementById('list')
  fetch('api/files').then((r) => r.json()).then((files) => {
    for (const file of files) {
      const button = document.createElement('button')
      button.textContent = file.title
      button.onclick = () => parent.postMessage({ type: 'beacon.play', mode: 'now',
        item: { audioUrl: '../audio/' + file.path, title: file.title, artist: 'Folder' } }, '*')
      list.append(button)
    }
  })
  addEventListener('message', (event) => {
    if (event.source !== parent || event.data.type !== 'beacon.theme') return
    const c = event.data.colors, s = document.body.style
    s.setProperty('--bg', c.background); s.setProperty('--fg', c['on-background'])
    s.setProperty('--surface', c.surface); s.setProperty('--primary', c.primary)
  })
  parent.postMessage({ type: 'beacon.ready' }, '*')
</script></body></html>"""


def audio_files():
    for name in sorted(os.listdir(FOLDER)):
        if name.lower().endswith(AUDIO):
            yield {"path": quote(name), "title": os.path.splitext(name)[0]}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/v1":
            self.send_body(json.dumps({"name": "Folder", "version": "1", "capabilities": []}),
                           "application/json")
        elif path == "/ui/":
            self.send_body(PAGE, "text/html; charset=utf-8")
        elif path == "/ui/api/files":
            self.send_body(json.dumps(list(audio_files())), "application/json")
        elif path.startswith("/audio/"):
            self.send_audio(os.path.basename(unquote(path[len("/audio/"):])))
        else:
            self.send_error(404)

    def send_body(self, text, content_type):
        body = text.encode()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_audio(self, name):
        file = os.path.join(FOLDER, name)
        if not name.lower().endswith(AUDIO) or not os.path.isfile(file):
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
        self.send_header("Content-Type", mimetypes.guess_type(name)[0] or "application/octet-stream")
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
    print(f"Serving {FOLDER} on port 8800")
    ThreadingHTTPServer(("0.0.0.0", 8800), Handler).serve_forever()
```

## Letting an AI write it

Settings > Library > External source > **Copy instructions for an AI** copies
a prompt with everything above that matters for writing an app. Add what the
app should do and in which language.
