import { resolve } from 'path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';

// The party-mode guest page (src/renderer/src/party/), built into
// connect/static/party/ where connect serves it under /party/ - in the
// desktop app (bundled with connect) and in the Docker image alike. Same
// renderer setup as web.vite.config.ts, so the page shares the app's
// components, theme and translations.
export default defineConfig({
    base: '/party/',
    resolve: {
        alias: {
            '@': resolve('src/renderer/src'),
        },
    },
    plugins: [vue(), vuetify({ autoImport: true })],
    root: 'src/renderer/party',
    build: {
        outDir: resolve('connect/static/party'),
        emptyOutDir: true,
    },
});
