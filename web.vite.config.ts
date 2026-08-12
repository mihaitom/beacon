import { resolve } from 'path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';

// Plain web build of the renderer only (no main/preload) — used by the
// Docker image (see Dockerfile's frontend-builder stage), served by nginx.
// Same renderer setup as electron.vite.config.ts's `renderer` block (alias,
// plugins, root), just without electron-vite's multi-target orchestration
// and with its own output directory so it can't collide with `npm run
// build`'s out/renderer.
export default defineConfig({
    resolve: {
        alias: {
            '@': resolve('src/renderer/src'),
        },
    },
    plugins: [vue(), vuetify({ autoImport: true })],
    root: 'src/renderer',
    build: {
        outDir: resolve('out/web'),
        emptyOutDir: true,
    },
});
