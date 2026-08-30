// api.js — talks to /remote/* on the same origin this page was loaded from
// (see routes/remote.py's serve_remote_app — the shell is always served by
// connect itself, so every fetch/EventSource here is same-origin, no CORS).

const STORAGE_KEY = 'beacon_remote_password';

export function getStoredPassword() {
  return localStorage.getItem(STORAGE_KEY);
}

export function setStoredPassword(password) {
  localStorage.setItem(STORAGE_KEY, password);
}

export function clearStoredPassword() {
  localStorage.removeItem(STORAGE_KEY);
}

class UnauthorizedError extends Error {}

async function request(path, options = {}) {
  const password = getStoredPassword();
  const headers = { ...options.headers };
  if (password) headers['X-Remote-Password'] = password;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401 || response.status === 404) {
    // 404 here means the feature got disabled server-side (see
    // require_remote_password) — same "no longer connected" outcome as a
    // wrong password from this client's point of view. Dispatched globally
    // rather than left to each call site's own .catch(), since a stale
    // password can surface from any of the several independent API calls
    // views make (fetchSongs, sendCommand, ...), and they should all funnel
    // into the same "go back to login" handling in app.js.
    window.dispatchEvent(new CustomEvent('beacon-remote-unauthorized'));
    throw new UnauthorizedError('Not authorized');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  return response.json();
}

export { UnauthorizedError };

export async function login(pin) {
  const response = await fetch('/remote/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Login failed (${response.status})`);
  }
  const { password } = await response.json();
  setStoredPassword(password);
  return password;
}

/** Resolves only once the renderer has actually applied the command — see
 * routes/remote.py's send_command(). Callers that have somewhere to show
 * the outcome (sheet.js's action sheet) await it; everything else should
 * use fireCommand() below rather than dropping the promise on the floor. */
export function sendCommand(type, payload = {}) {
  return request('/remote/command', { method: 'POST', body: { type, payload } });
}

/** Fire-and-forget counterpart for the many call sites with no UI of their
 * own to report into — a transport button, a volume slider, a queue row.
 * Since sendCommand() started blocking on the renderer's ack it also
 * started *rejecting* (504 when the renderer never answered, 502 when it
 * answered with an error), and calling it bare left those as unhandled
 * promise rejections with the person who tapped seeing nothing at all.
 * Not silent: the banner keeps "that didn't happen" from looking like
 * "Beacon ignored me". */
export function fireCommand(type, payload = {}) {
  sendCommand(type, payload).catch((error) => {
    // Already handled globally — request() dispatches its own event and
    // app.js sends the user back to the login screen.
    if (error instanceof UnauthorizedError) return;
    console.error('[remote] Command failed:', type, error);
    window.dispatchEvent(new CustomEvent('beacon-remote-command-failed'));
  });
}

export function fetchSongs(search, offset, limit) {
  const params = new URLSearchParams({ search, offset: String(offset), limit: String(limit) });
  return request(`/remote/songs?${params}`);
}

export function fetchPlaylists() {
  return request('/remote/playlists');
}

export function fetchPlaylist(id) {
  return request(`/remote/playlists/${encodeURIComponent(id)}`);
}

export function fetchRadioStations() {
  return request('/remote/radio-stations');
}

export function fetchDevices() {
  return request('/remote/devices');
}

export function fetchDeviceVolume(deviceType, name) {
  const params = new URLSearchParams({ type: deviceType, name });
  return request(`/remote/device-volume?${params}`);
}

export function fetchInitialState() {
  return request('/remote/state');
}

export function connectEvents(onSnapshot, onConnectionChange) {
  const password = getStoredPassword();
  const source = new EventSource(`/remote/events?password=${encodeURIComponent(password)}`);
  source.onopen = () => onConnectionChange(true);
  source.onerror = () => {
    onConnectionChange(false);
    // Per the EventSource spec, a non-2xx response (401/404 — wrong or
    // stale password, or the feature got disabled) fails the connection
    // outright (readyState -> CLOSED, no automatic retry) rather than
    // scheduling a reconnect like a transient network blip would — that's
    // the one case worth bouncing back to the login screen for.
    if (source.readyState === EventSource.CLOSED) {
      window.dispatchEvent(new CustomEvent('beacon-remote-unauthorized'));
    }
  };
  source.onmessage = (event) => {
    try {
      onSnapshot(JSON.parse(event.data));
    } catch {
      // heartbeat comments never reach onmessage; ignore anything else malformed
    }
  };
  return source;
}
