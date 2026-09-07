# docs/

Six things live here, and they answer different questions.

| What                                                 | Open it when                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [styleguide.md](styleguide.md)                       | Building or reshaping any UI. It says which shared class to reach for and records the decisions that are not obvious from the CSS. `src/renderer/src/assets/base.css` is the actual source of truth; when the two disagree, the code is right and the file is stale. |
| [styleguide.html](styleguide.html)                   | Same thing, rendered. Open it in a browser to look at the panels, headings and rows rather than read about them - it loads the real `base.css`.                                                                                                                      |
| [transcoding-decisions.md](transcoding-decisions.md) | Asking why a track or station came out in a particular format. A map of what actually decides the output on each path, read out of the code rather than assumed.                                                                                                     |
| [investigations/](investigations/README.md)          | Before chasing anything about streaming, casting or the playback clock. One file per hard case, including the theories that were ruled out. Not limited to playback, or to bugs.                                                                                     |
| [plugin-system.md](plugin-system.md)                 | The plan for a plugin system that is deliberately not built yet, and why the ordering is what it is.                                                                                                                                                                 |
| screenshots/                                         | Only the images `README.md` embeds.                                                                                                                                                                                                                                  |

Everything else about how the two halves of the app fit together is in
`CLAUDE.md` at the repository root.
