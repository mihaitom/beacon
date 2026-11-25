# The guest page bundles the app's whole store layer

**Status:** open, found 2026-11-25 while looking at two `INEFFECTIVE_DYNAMIC_IMPORT`
warnings in the party build. Nothing breaks: it costs download size and runs
app code on a page that has no use for it. Present since at least 2026-10-18,
when the guest page started using the appearance store.

## What happens

`NowPlayingPresentation.vue` reads the appearance store directly (`nightTheme`,
`adaptiveAccent`, `borrowAccent()`), so `party/main.ts` creates a Pinia and sets
the store's state to Beacon with adaptive accent. That one import pulls in:

```
party/main.ts → stores/appearance.ts → services/accountKey.ts → stores/auth.ts
  → stores/playback.ts → stores/playback/* → stores/equalizer.ts, stores/connect.ts, ...
```

`accountKey.ts` calls `useAuthStore()`, and `stores/auth.ts` statically imports
the playback and connect stores. A second, lazy route goes through the dynamic
`import('@/services/connect/accountSettings')` in `appearance.ts`, which also
imports `stores/auth.ts`.

The appearance store's state init calls `accountScopedKey()`, so the auth store
is actually instantiated on the guest page and reads the app's login from
localStorage, since guest page and app share the origin. Nothing comes of it,
but it is app state the guest page should not touch.

The two warnings themselves are harmless and also appear without the guest
page: `stores/equalizer.ts` uses `import()` to break an import cycle, not to
split code (see its comment), so there is nothing to fix there.

## Measured

Party build, main chunk (2026-11-25, `development` at `248de1ec`):

|                             | minified | gzip   |
| --------------------------- | -------- | ------ |
| as it is                    | 1067 kB  | 354 kB |
| `accountKey.ts` stubbed out | 945 kB   | 317 kB |

The stores then move into a lazy chunk the guest page never loads. The rest of
the bundle is Vuetify, the Now Playing components and Butterchurn (its own
chunk).

## What to do

The rule in `CLAUDE.md` and `docs/plans/now-playing-shared-with-party.md`
already covers this: components under `components/now-playing/` get what they
need from `source.ts`, not from a store. So:

1. Add `nightTheme`, `adaptiveAccent` and the accent borrowing to the source
   (`hostSource.ts` reads the appearance store, `guestSource.ts` returns Beacon
   with adaptive accent).
2. Drop `useAppearanceStore` from `NowPlayingPresentation.vue`.
3. Remove the appearance store import and the `Object.assign` from
   `party/main.ts`. Pinia stays: the guest page has its own store
   (`party/store.ts`).

Check afterwards with a party build into a scratch folder (not
`connect/static/party`, which a running dev session serves): the main chunk
should shrink by about the measured amount, and no `stores/` module should be
reachable from `party/main.ts`.
