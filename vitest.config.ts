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
    },
});
