# Dependency majors: TypeScript 7

**Status:** waiting on the Vue tooling (as of 2026-11-15). Done already:
Electron 39->44, electron-vite 4->6, @types/node 24->26, Vuetify 3->4,
Vite 7->8.

- **TypeScript 6 -> 7: not yet.** TypeScript 7.0 is out, but `vue-tsc`
  (3.3.14, the current release) works by loading and patching TypeScript's
  own JavaScript compiler, which TypeScript 7 no longer ships - so
  `pnpm type-check` cannot run on it. Its successor, Vue Language Tools v4,
  has TypeScript 7's own `tsc` check `.vue` files instead, and is at
  `4.0.0-alpha.3` on npm, with editor support not ready yet
  (vuejs/language-tools#6121). Revisit once v4 has a stable release, and
  try `pnpm type-check` with it before trusting the announcement.

Not forced: no workaround, no beta build tool in the release pipeline.
