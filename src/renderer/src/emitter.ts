import mitt from 'mitt'
import type { AppEvents } from './types/events'

export const emitter = mitt<AppEvents>()

declare module 'vue' {
  interface ComponentCustomProperties {
    /** Global event bus (see types/events.ts's AppEvents) — e.g.
     * `this.$emitter.emit('toast', { level: 'error', ... })` from any
     * Options API component without importing `emitter` directly. */
    $emitter: typeof emitter
  }
}
