import type Toast from './toast'

/** Shorthand form for emitter.emit('toast', ...) — [level, title, message]. */
export type ToastTuple = [Toast['level'], string, string]

export type AppEvents = {
  toast: Toast | ToastTuple
  openReleaseNotes: void
}
