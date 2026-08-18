// state.js — tiny plain-object store with subscriber notification. No
// framework: this is a single-purpose phone remote, not worth a build step.

const listeners = new Set();

export const state = {
  snapshot: {
    playing: false,
    position: 0,
    duration: 0,
    volume: 1,
    shuffle: false,
    repeat: 'off',
    current_song: null,
    radio: null,
    queue: [],
    queue_index: -1,
    casting: [],
    device_volume: null,
  },
  connected: false,
};

export function setSnapshot(snapshot) {
  state.snapshot = { ...state.snapshot, ...snapshot };
  notify();
}

export function setConnected(connected) {
  state.connected = connected;
  notify();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener(state);
}
