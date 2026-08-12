import { ElectronAPI } from '@electron-toolkit/preload';

interface SecureStorageApi {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

interface AppConfigApi {
    getConnectDefaults(): Promise<{ connectToken: string; connectUrl: string }>;
}

declare global {
    interface Window {
        // Absent in the web build (no Electron preload) — every access needs
        // to handle that (see stores/auth.ts's window.api-optional branches).
        electron?: ElectronAPI;
        api?: {
            secureStorage: SecureStorageApi;
            appConfig: AppConfigApi;
        };
        // Injected by the web/Docker build's settings.js (see
        // settings.js.template + ng.conf.template) — nginx's same-origin
        // "/api" location for connect-native calls (see services/connect/
        // http.ts). __CONNECT_TOKEN__ is deliberately never set there —
        // nginx injects X-Connect-Token server-side instead, so the browser
        // never has to know it (see stores/auth.ts's loadConnectDefaults()).
        // Both are absent in the Electron build.
        __CONNECT_URL__?: string;
        __CONNECT_URL_BASE__?: string;
        __CONNECT_TOKEN__?: string;
    }
}
