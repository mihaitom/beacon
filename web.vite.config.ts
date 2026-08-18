import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';
import { config as loadDotenv } from 'dotenv';

// Mirrors src/main/index.ts's readConnectDefaults() — same precedence
// (explicit CONNECT_TOKEN in connect/.env, then the backend's own persisted
// connect/.connect-token, same PORT default) so this config's dev-server
// proxy (see below) can stand in for nginx's identical job in the real
// Docker deployment (see ng.conf.template's X-Connect-Token injection) —
// nothing the renderer itself needs to know about either way
// (window.__CONNECT_TOKEN__ is deliberately never set, see
// settings.js.template's comment; loadConnectDefaults() hardcodes '' in the
// web build for the same reason).
function readConnectDevDefaults(): { token: string; port: string } {
    const connectDir = resolve('connect');
    const envPath = resolve(connectDir, '.env');
    const parsed = existsSync(envPath) ? (loadDotenv({ path: envPath }).parsed ?? {}) : {};
    const port = parsed.PORT || '7071';

    let token = parsed.CONNECT_TOKEN ?? '';
    if (!token) {
        const tokenFile = resolve(connectDir, '.connect-token');
        if (existsSync(tokenFile)) token = readFileSync(tokenFile, 'utf-8').trim();
    }
    return { token, port };
}

// Plain web build of the renderer only (no main/preload) — used by the
// Docker image (see Dockerfile's frontend-builder stage), served by nginx.
// Same renderer setup as electron.vite.config.ts's `renderer` block (alias,
// plugins, root), just without electron-vite's multi-target orchestration
// and with its own output directory so it can't collide with `npm run
// build`'s out/renderer.
export default defineConfig(() => {
    const { token, port } = readConnectDevDefaults();

    return {
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
        server: {
            // Not just localhost — `pnpm dev:web` exists specifically to test
            // the mobile view (see composables/useIsMobileWeb.ts) from an
            // actual phone on the same LAN, same as the real deployment's
            // `network_mode: host`. Vite prints the resulting "Network:"
            // URL to open on the phone.
            host: true,
            port: 5273,
            // Mirrors all four of ng.conf.template's proxied location blocks,
            // not just /api — connectUrl (used by SubsonicClient for /rest/*,
            // and for /auth/*, /stream) defaults to '' in the web build (see
            // loadConnectDefaults()), i.e. bare unprefixed paths against this
            // same origin, exactly like nginx's own /rest/, /auth/, /stream
            // blocks expect. Missing any one of these doesn't 404 loudly —
            // it silently falls through to vite's SPA index.html fallback,
            // which then fails JSON.parse() at the call site instead.
            proxy: {
                // Same prefix loadConnectDefaults() falls back to
                // (window.__CONNECT_URL__ ?? '/api') when no settings.js has
                // set it — nothing to configure on the renderer side for
                // this to already line up.
                '/api': {
                    target: `http://127.0.0.1:${port}`,
                    changeOrigin: true,
                    // Mirrors ng.conf.template's trailing-slash proxy_pass
                    // trick, which strips the "/api" prefix down to the
                    // backend root (see connect/routes/proxy.py's own
                    // "nginx strips /api/" comment — same assumption here).
                    rewrite: (path) => path.replace(/^\/api/, ''),
                    configure(proxy) {
                        proxy.on('proxyReq', (proxyReq) => {
                            proxyReq.setHeader('X-Connect-Token', token);
                        });
                    },
                },
                // /rest, /auth, /stream all pass straight through unprefixed
                // (connect/routes/proxy.py's own /rest/{path} route matches
                // this literally, same as a direct Electron connection would
                // hit) — no rewrite needed, just the token injection.
                '/rest': {
                    target: `http://127.0.0.1:${port}`,
                    changeOrigin: true,
                    configure(proxy) {
                        proxy.on('proxyReq', (proxyReq) => {
                            proxyReq.setHeader('X-Connect-Token', token);
                        });
                    },
                },
                '/auth': {
                    target: `http://127.0.0.1:${port}`,
                    changeOrigin: true,
                    configure(proxy) {
                        proxy.on('proxyReq', (proxyReq) => {
                            proxyReq.setHeader('X-Connect-Token', token);
                        });
                    },
                },
                '/stream': {
                    target: `http://127.0.0.1:${port}`,
                    changeOrigin: true,
                    configure(proxy) {
                        proxy.on('proxyReq', (proxyReq) => {
                            proxyReq.setHeader('X-Connect-Token', token);
                        });
                    },
                },
            },
        },
    };
});
