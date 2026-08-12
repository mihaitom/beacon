import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';

export default defineConfig({
    main: {
        build: {
            sourcemap: true,
        },
        plugins: [externalizeDepsPlugin()],
    },
    preload: {
        build: {
            sourcemap: true,
        },
        plugins: [externalizeDepsPlugin()],
    },
    renderer: {
        resolve: {
            alias: {
                '@': resolve('src/renderer/src'),
            },
        },
        plugins: [vue(), vuetify({ autoImport: true })],
        root: 'src/renderer',
        server: {
            // ReleaseNotes.vue reads CHANGELOG.md and package.json from the
            // project root via `?raw`/JSON imports, both outside `root`
            // above — Vite's dev server otherwise refuses to serve files
            // from outside the configured root.
            fs: {
                allow: [resolve('.')],
            },
        },
    },
});
