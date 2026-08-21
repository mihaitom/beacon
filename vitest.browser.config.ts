import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { playwright } from '@vitest/browser-playwright';

// Separate config from vitest.config.ts's jsdom project, for layout
// regression tests only (*.browser.test.ts) — real Chromium instead of
// jsdom, so container queries/clamp()/the flip-card's 3D transform actually
// compute the way a real window would. These are slower (a real browser
// launches per run) and few in number, so they're kept out of the default
// `pnpm test:unit` loop — see package.json's `test:layout`.
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
