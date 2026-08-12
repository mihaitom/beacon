import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

const api = {
    secureStorage: {
        get: (key: string): Promise<string | null> => ipcRenderer.invoke('secure-storage:get', key),
        set: (key: string, value: string): Promise<void> =>
            ipcRenderer.invoke('secure-storage:set', key, value),
        delete: (key: string): Promise<void> => ipcRenderer.invoke('secure-storage:delete', key),
    },
    appConfig: {
        getConnectDefaults: (): Promise<{ connectToken: string; connectUrl: string }> =>
            ipcRenderer.invoke('app-config:get-connect-defaults'),
    },
};

if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('electron', electronAPI);
        contextBridge.exposeInMainWorld('api', api);
    } catch (error) {
        console.error(error);
    }
} else {
    // @ts-expect-error (define in dts)
    window.electron = electronAPI;
    // @ts-expect-error (define in dts)
    window.api = api;
}
