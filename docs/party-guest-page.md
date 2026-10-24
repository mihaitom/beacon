# The party guest page

How the page party guests open is built. Using party mode is in
[help/guides/party-mode.md](help/guides/party-mode.md), exposing it in
[help/guides/party-over-the-internet.md](help/guides/party-over-the-internet.md).

The guest page is a Vue app of its own (`src/renderer/src/party/`), built
with `pnpm build:party` into `connect/static/party/`, which connect serves.
`pnpm dev` keeps it built while you work, `pnpm package:connect` and the
Docker image build it themselves. It reuses the app's theme, translations
and the parts of Now Playing that know no store (backdrop, lyrics lines,
visualizer bars), so it looks the same without carrying the app's playback
code along.

Vuetify writes its theme into a `<style>` element at runtime. Instead of
allowing inline styles, connect puts a fresh nonce into every page it serves
and allows only the style element carrying it.

The visualizer comes from connect, which analyses what the speakers play
while the host casts. During local playback the analyser lives in the host's
browser, so guests in the room see no bars then; guests of an online party
still do, from the stream they hear.
