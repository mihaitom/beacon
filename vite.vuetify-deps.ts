import { createRequire } from 'module';

// Every module the Vuetify auto-import can emit, read from the same map it
// uses, for the dev servers' optimizeDeps.include. Vite's dependency scan
// never sees these imports (they are added while a template is compiled), so
// each component used for the first time on a page used to make the dev
// server re-bundle and reload the whole UI mid-session.
const importMap: { components: Record<string, { from: string }> } = createRequire(
    import.meta.url,
)('vuetify/dist/json/importMap.json');

export const vuetifyComponentModules = [
    ...new Set(Object.values(importMap.components).map(({ from }) => `vuetify/${from}`)),
];
