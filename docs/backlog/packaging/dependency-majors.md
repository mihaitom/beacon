# Dependency majors: Vite 8 and TypeScript 7

**Status:** Vite 8 ready to do, TypeScript 7 to be checked again (as of
2026-10-25). Done already: Electron 39->44, electron-vite 4->6, @types/node
24->26, Vuetify 3->4.

- **Vite 7 -> 8 is no longer blocked.** electron-vite 6.0.0 is stable, is
  already in use, and allows `vite ^6 || ^7 || ^8` in its `peerDependencies`.
- **TypeScript 6 -> 7: check again.** The upstream issue
  vuejs/language-tools#5381 has been closed since 2026-07-23, but according
  to its maintainer full support for TS 7.1 is still to come (it waits on the
  content mappers in typescript-go, microsoft/typescript-go#4712). Try
  `pnpm type-check` with TS 7 first rather than relying on an announcement.

Neither is forced: no workaround, no beta build tool in the release
pipeline.
