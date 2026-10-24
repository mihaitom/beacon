# docs/

What lives here, and when to open it. `help/` is for people running Beacon,
the rest for people working on it.

Everything in `help/` is also the app's help, one file per page
(`services/help/docs.ts` picks the folder up as it is), in three groups by
folder: `faq/`, short answers, one file per topic; `guides/`, step by step,
to set something up or use it; `reference/`, to look things up in. A page
for one reader goes into one group - a guide that grows an API reference
or a list of proxy setups is two pages. `features.md` is the one file
outside them; the app shows it as the first entry of the FAQ ("What Beacon
can do"). A file's `# ` heading is its title in the app, and `order:` in its
front matter its place in its group. Links between them are followed inside
the app, so a renamed heading or a moved file needs the links to it updated
too - the frontend suite checks every one, and every page the app opens.
Headings between a `<!-- tabs -->` and a `<!-- /tabs -->` line are shown as
tabs, for alternatives of which a reader wants one, like one reverse proxy's
setup. For cases that took real digging, including the theories that were
ruled out, see `investigations/`.

| What                                                                               | Open it when                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [help/faq/](help/faq/)                                                             | Wondering why Beacon behaves a particular way: casting, playback, transitions, formats, the library, privacy, and what to send with a bug report.                                                                                                                    |
| [help/features.md](help/features.md)                                               | What Beacon can do, in full. The root `README.md` keeps a short version and links here.                                                                                                                                                                              |
| [help/guides/networking.md](help/guides/networking.md)                             | Speakers are not found, or stop or start a song over: which connections casting needs, ports, Docker, several networks, VLANs, Wi-Fi.                                                                                                                                |
| [help/guides/party-mode.md](help/guides/party-mode.md)                             | Running a party: what guests can and cannot do, the online party, how a party survives a sleeping window.                                                                                                                                                            |
| [help/guides/party-over-the-internet.md](help/guides/party-over-the-internet.md)   | Letting party guests in from outside: what the reverse proxy needs, setups for the common ones, client addresses, the security model.                                                                                                                                |
| [help/guides/home-automation.md](help/guides/home-automation.md)                   | Connecting Home Assistant to the desktop app: the key, the fixed port, mDNS.                                                                                                                                                                                         |
| [help/reference/transcoding-decisions.md](help/reference/transcoding-decisions.md) | Asking why a track or station came out in a particular format: a map of what actually decides it.                                                                                                                                                                    |
| [help/reference/home-automation-api.md](help/reference/home-automation-api.md)     | Writing an integration of your own: authentication, the state, the commands.                                                                                                                                                                                         |
| [party-guest-page.md](party-guest-page.md)                                         | Working on the party guest page: how it is built and served.                                                                                                                                                                                                         |
| [cast-permissions.md](cast-permissions.md)                                         | Understanding or changing who may cast to devices: the household allow-list, why it is a policy and not a security boundary, and how the account identity is verified. Docker/web only.                                                                              |
| [styleguide.md](styleguide.md)                                                     | Building or reshaping any UI. It says which shared class to reach for and records the decisions that are not obvious from the CSS. `src/renderer/src/assets/base.css` is the actual source of truth; when the two disagree, the code is right and the file is stale. |
| [styleguide.html](styleguide.html)                                                 | Same thing, rendered. Open it in a browser to look at the panels, headings and rows rather than read about them - it loads the real `base.css`.                                                                                                                      |
| [investigations/](investigations/README.md)                                        | Before chasing anything about streaming, casting or the playback clock. One file per hard case, including the theories that were ruled out. Not limited to playback, or to bugs.                                                                                     |
| [backlog/](backlog/README.md)                                                      | Looking for what is still to be built or decided, by area, one file per item.                                                                                                                                                                                        |
| [plans/](plans/)                                                                   | Designing a larger feature before building it; each plan says at the top how far it got.                                                                                                                                                                             |
| screenshots/                                                                       | Only the images `README.md` embeds.                                                                                                                                                                                                                                  |

Everything else about how the two halves of the app fit together is in
`CLAUDE.md` at the repository root.
