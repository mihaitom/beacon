# docs/

What lives here, and when to open it. `help/` is for people running Beacon,
the rest for people working on it.

Everything in `help/` is also the app's help, one file per page
(`services/help/docs.ts` picks the folder up as it is): the FAQ in `faq/`, one
file per topic, the guides beside it, and `features.md`, which the app shows
as the first entry of the FAQ ("What Beacon can do"). A file's `# ` heading is its
title in the app, and `order:` in its front matter its place in the list.
Links between them are followed inside the app, so a renamed heading needs
the links to it updated too - the frontend suite checks every one. Headings
between a `<!-- tabs -->` and a `<!-- /tabs -->` line are shown as tabs,
for alternatives of which a reader wants one, like one reverse proxy's setup.
For the reasoning behind the format answers, see
`help/transcoding-decisions.md`; for cases that took real digging, including
the theories that were ruled out, `investigations/`.

| What                                                           | Open it when                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [help/faq/](help/faq/)                                         | Wondering why Beacon behaves a particular way, what leaves the deployment, or what to check when a speaker does not turn up. One file per topic; `README.md` links here question by question.                                                                                        |
| [help/networking.md](help/networking.md)                       | Speakers are not found, or stop or start a song over: which connections casting needs, ports, Docker, several networks, VLANs, Wi-Fi.                                                                                                                                                |
| [help/features.md](help/features.md)                           | What Beacon can do, in full. The root `README.md` keeps a short version and links here.                                                                                                                                                                                              |
| [help/party-mode.md](help/party-mode.md)                       | Running a party: what guests can and cannot do, the security model, and reverse proxy setups for letting guests in from outside.                                                                                                                                                     |
| [help/home-automation.md](help/home-automation.md)             | Connecting Home Assistant or another tool to the desktop app: the key, the fixed port, the mDNS announcement, and every state field and command an integration can rely on. The ready-made Home Assistant integration and its guide are in `home-assistant/` at the repository root. |
| [help/transcoding-decisions.md](help/transcoding-decisions.md) | Asking why a track or station came out in a particular format. A map of what actually decides the output on each path, read out of the code rather than assumed.                                                                                                                     |
| [cast-permissions.md](cast-permissions.md)                     | Understanding or changing who may cast to devices: the household allow-list, why it is a policy and not a security boundary, and how the account identity is verified. Docker/web only.                                                                                              |
| [styleguide.md](styleguide.md)                                 | Building or reshaping any UI. It says which shared class to reach for and records the decisions that are not obvious from the CSS. `src/renderer/src/assets/base.css` is the actual source of truth; when the two disagree, the code is right and the file is stale.                 |
| [styleguide.html](styleguide.html)                             | Same thing, rendered. Open it in a browser to look at the panels, headings and rows rather than read about them - it loads the real `base.css`.                                                                                                                                      |
| [investigations/](investigations/README.md)                    | Before chasing anything about streaming, casting or the playback clock. One file per hard case, including the theories that were ruled out. Not limited to playback, or to bugs.                                                                                                     |
| screenshots/                                                   | Only the images `README.md` embeds.                                                                                                                                                                                                                                                  |

Everything else about how the two halves of the app fit together is in
`CLAUDE.md` at the repository root.
