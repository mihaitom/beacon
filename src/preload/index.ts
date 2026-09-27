import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface ConnectPortInfo {
  port: number | null
  fromEnvironment: boolean
  current: number | null
}

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
    getConnectPort: (): Promise<ConnectPortInfo> =>
      ipcRenderer.invoke('app-config:get-connect-port'),
    setConnectPort: (port: number | null): Promise<void> =>
      ipcRenderer.invoke('app-config:set-connect-port', port),
  },
  appLifecycle: {
    // Main can't stop an active cast session itself (see main/index.ts —
    // it doesn't know the per-login connect session id, only the
    // renderer's auth store does), so it asks the renderer to do it and
    // waits for beforeQuitDone() before actually exiting.
    onBeforeQuit: (handler: () => void): void => {
      ipcRenderer.on('app:before-quit', () => handler())
    },
    beforeQuitDone: (): void => {
      ipcRenderer.send('app:before-quit-done')
    },
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error (define in dts)
  window.electron = electronAPI
  // @ts-expect-error (define in dts)
  window.api = api
}
