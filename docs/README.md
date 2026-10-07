# docs/

What lives here, and when to open it. The first four are for people running
Beacon, the rest for people working on it.

The app shows four of them in its help dialog (`services/help/docs.ts`):
the FAQ, party mode, home automation and transcoding decisions. Links
between them are followed inside the app, so a renamed heading needs the
links to it updated too - the frontend suite checks every one. The FAQ is
shown one `##` topic at a time, so its `##` headings are what the app's
topic list offers, and the text above the first one only shows on GitHub.
The root `README.md`'s Features section, down to the next `##` heading, is
shown in the app as well, in a dialog of its own ("What Beacon can do"),
leaving out the keyboard shortcuts, which the app lists in their own dialog.

| What                                                 | Open it when                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [faq.md](faq.md)                                     | Wondering why Beacon behaves a particular way, what leaves the deployment, or what to check when a speaker does not turn up. The user-facing answers `README.md` links to question by question; the reasoning behind the format ones is in `transcoding-decisions.md`.               |
| [party-mode.md](party-mode.md)                       | Running a party: what guests can and cannot do, the security model, and reverse proxy setups for letting guests in from outside.                                                                                                                                                     |
| [home-automation.md](home-automation.md)             | Connecting Home Assistant or another tool to the desktop app: the key, the fixed port, the mDNS announcement, and every state field and command an integration can rely on. The ready-made Home Assistant integration and its guide are in `home-assistant/` at the repository root. |
| [cast-permissions.md](cast-permissions.md)           | Understanding or changing who may cast to devices: the household allow-list, why it is a policy and not a security boundary, and how the account identity is verified. Docker/web only.                                                                                              |
| [styleguide.md](styleguide.md)                       | Building or reshaping any UI. It says which shared class to reach for and records the decisions that are not obvious from the CSS. `src/renderer/src/assets/base.css` is the actual source of truth; when the two disagree, the code is right and the file is stale.                 |
| [styleguide.html](styleguide.html)                   | Same thing, rendered. Open it in a browser to look at the panels, headings and rows rather than read about them - it loads the real `base.css`.                                                                                                                                      |
| [transcoding-decisions.md](transcoding-decisions.md) | Asking why a track or station came out in a particular format. A map of what actually decides the output on each path, read out of the code rather than assumed.                                                                                                                     |
| [investigations/](investigations/README.md)          | Before chasing anything about streaming, casting or the playback clock. One file per hard case, including the theories that were ruled out. Not limited to playback, or to bugs.                                                                                                     |
| screenshots/                                         | Only the images `README.md` embeds.                                                                                                                                                                                                                                                  |

Everything else about how the two halves of the app fit together is in
`CLAUDE.md` at the repository root.
