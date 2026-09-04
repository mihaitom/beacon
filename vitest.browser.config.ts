import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { playwright } from '@vitest/browser-playwright';

// Separate config from vitest.config.ts's jsdom project, for the tests that
// need a real browser (*.browser.test.ts) — real Chromium instead of jsdom.
// Two kinds qualify: layout regression tests, where container
// queries/clamp()/the flip-card's 3D transform actually compute the way a
// real window would, and the persistent artwork store, which jsdom has no
// IndexedDB for at all (a stand-in would only test the stand-in). These are
// slower (a real browser launches per run) and few in number, so they're
// kept out of the default `pnpm test:unit` loop — see package.json's
// `test:layout`.
export default defineConfig({
    resolve: {
        alias: {
            '@': resolve('src/renderer/src'),
        },
    },
    plugins: [vue()],
    test: {
        include: ['src/renderer/src/**/__tests__/**/*.browser.test.ts'],
        browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
        },
    },
});
