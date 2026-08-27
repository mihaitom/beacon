import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// Renderer-only for now (src/main and src/preload are thin Electron glue,
// not worth a second test environment) — mirrors the `@` alias and Vue
// plugin from electron.vite.config.ts's `renderer` block so components and
// stores resolve the same way under test as they do under electron-vite.
export default defineConfig({
    resolve: {
        alias: {
            '@': resolve('src/renderer/src'),
        },
    },
    plugins: [vue()],
    test: {
        environment: 'jsdom',
        include: ['src/renderer/src/**/__tests__/**/*.test.ts'],
        // *.browser.test.ts (see vitest.browser.config.ts) needs real CSS
        // layout — container queries, clamp(), the flip-card's 3D
        // transform — none of which jsdom actually computes. Excluded here
        // so this project doesn't also try to run them (they'd "pass"
        // against jsdom's fake layout without checking anything real).
        exclude: ['**/node_modules/**', '**/*.browser.test.ts'],
        setupFiles: ['src/renderer/src/__tests__/setup.ts'],
        coverage: {
            provider: 'v8',
            // Reported over every renderer source file, not just the ones a
            // test happened to import — a file nothing covers has to show up
            // as 0%, otherwise the total only describes the code that is
            // already tested and rises as coverage gets *narrower*.
            include: ['src/renderer/src/**/*.{ts,vue}'],
            exclude: [
                // Translation tables: thousands of lines of string literals
                // that no test asserts on directly and that would swamp
                // every other number in the report.
                'src/renderer/src/i18n/locales/**',
                // Type-only modules compile away to nothing executable, so
                // v8 reports them as 0% forever regardless of use.
                'src/renderer/src/**/types.ts',
                // App bootstrap — runs only against a real DOM at startup.
                'src/renderer/src/main.ts',
            ],
            reporter: ['text-summary', 'html'],
            reportsDirectory: 'coverage/renderer',
        },
        server: {
            // Vitest externalizes node_modules deps by default (Node requires
            // them directly, bypassing Vite's transform pipeline) — Vuetify's
            // components each carry a side-effect .css import that only Vite
            // knows how to handle, so a plain Node require of one blows up
            // with "Unknown file extension .css" the moment a component test
            // mounts real Vuetify components (v-btn, v-slider, ...) instead
            // of stubbing them.
            deps: { inline: [/vuetify/] },
        },
    },
});
