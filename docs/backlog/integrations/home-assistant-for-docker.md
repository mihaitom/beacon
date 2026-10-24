# Home Assistant for Docker/web too

**Status:** open, not decided - worth deciding only once someone running
Docker asks. Requests so far only for the desktop app (#36).

As of 2026-09-27 the integration (integration key, mDNS, the
`home-assistant/` integration with its "active Beacon") exists only for the
desktop app. The reason: there Home Assistant controls the one running
window, whose state the renderer sends to connect through the remote relay
(`stores/remoteControl.ts` -> `/remote/state`, commands through
`/remote/agent-events`). In a Docker setup there is no such window: every
browser tab is a player of its own, often of different users.

## Two ways

**A. A browser tab becomes the player** (roughly half a day to a day). The
technology is there: relay, key, mDNS and the HA integration work unchanged,
and in the web build the path goes through nginx, which inserts the token
itself. To build:

- lift the Electron locks (`App.vue` calls `refreshStatus()` only with
  `window.api`, `HomeAutomationSection.vue` has `v-if="isElectron"`);
- in Docker only an admin may create the key (like the API keys; the
  Advanced tab is admin-only there already);
- a switch "this browser is the player for Home Assistant";
- a rule "the tab that claimed it last wins", because `core/remote.py` knows
  only one `RemoteState`.

Limits: one player per installation, tab closed = "unavailable". Unchecked:
whether a paused background tab keeps up the keepalive (20 s, timeout
`KEEPALIVE_TIMEOUT` = 90 s) despite browser throttling. The fixed-port part
of the settings section stays Electron-only (in Docker `PORT` decides the
port). Makes sense for a wall tablet or an always-open browser.

**B. HA controls running casts directly on the server** (several days).
connect already knows each session's title with cover, queue, shuffle,
target speakers with volume (`build_status_dict()` in `core/session.py`), and
pause/resume/seek/stop/volume exist as endpoints (`routes/playback.py`,
`routes/volume.py`). To build:

- a new interface next to `/remote` that lists all running casts and offers
  status (SSE) and commands per cast, secured with the integration key;
- next/previous on the server - today the renderer decides what comes next,
  connect itself only moves on at a track's end (`_advance_or_end()` in
  `routes/stream.py`), and an open tab has to take over a skip triggered by
  HA cleanly through `reconcileFromStatus()` without its queue drifting
  apart (the most delicate part);
- the HA integration would have to create and remove players per cast
  ("Beacon: living room").

Permissions: whoever has the key sees and controls every user's casts - at
least document it. _Starting_ playback (a playlist, radio) is not possible
this way; connect lacks a user's media server login for it. Thorough backend
tests (see `CLAUDE.md`).

Background and architecture: `home-assistant/README.md`,
[the guide](../../help/guides/home-automation.md),
[the API reference](../../help/reference/home-automation-api.md).
