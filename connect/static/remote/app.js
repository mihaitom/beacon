import { login, getStoredPassword, setStoredPassword, clearStoredPassword, connectEvents, fetchInitialState, fireCommand } from './js/api.js';
import { setSnapshot, setConnected, subscribe } from './js/state.js';
import { startRouter } from './js/router.js';

import './js/views/now-playing.js';
import './js/views/queue.js';
import './js/views/playlists.js';
import './js/views/songs.js';
import './js/views/radio.js';

// Registering this is what actually makes Chrome/Android offer "Add to Home
// Screen" for the manifest above — a manifest alone isn't enough for
// installability. Scoped to /remote/app/ automatically (a service worker's
// default max scope is its own script's directory), so it never intercepts
// the API calls under plain /remote/* (see sw.js's own comment).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((error) => {
      console.error('[remote] Service worker registration failed:', error);
    });
  });
}

const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const disconnectedBanner = document.getElementById('disconnected-banner');
const interruptedBanner = document.getElementById('interrupted-banner');
const commandErrorBanner = document.getElementById('command-error-banner');

// api.js's fireCommand() raises this for the call sites that have nowhere
// of their own to report into (transport buttons, the volume slider, queue
// rows). A tap that quietly did nothing is worse than a failed one that
// says so — the natural response to the former is to tap again, which is
// how a "next" turns into a double skip. Auto-hides: this is a report on
// one action, not a state the app is stuck in like the two banners above.
let commandErrorTimer = null;
window.addEventListener('beacon-remote-command-failed', () => {
  commandErrorBanner.classList.remove('hidden');
  clearTimeout(commandErrorTimer);
  commandErrorTimer = setTimeout(() => commandErrorBanner.classList.add('hidden'), 4000);
});

// Nothing resumes on its own: from the server's side a speaker that stopped
// by itself and one somebody stopped are indistinguishable, so this asks
// rather than guesses. Mirrors the toast the desktop and mobile web UI raise
// for the same snapshot field.
interruptedBanner.addEventListener('click', () => {
  interruptedBanner.classList.add('hidden');
  fireCommand('resume-interrupted');
});

subscribe((s) => {
  interruptedBanner.classList.toggle('hidden', !s.snapshot.interrupted);
});

function consumePairingLink() {
  const hash = location.hash;
  const match = hash.match(/^#\/pair\?password=([^&]+)/);
  if (!match) return false;
  setStoredPassword(decodeURIComponent(match[1]));
  // Strip the plaintext password out of the visible URL/history immediately.
  history.replaceState(null, '', `${location.pathname}#/now-playing`);
  return true;
}

function showLogin(errorMessage) {
  loginScreen.classList.remove('hidden');
  appScreen.classList.add('hidden');
  const errorEl = document.getElementById('login-error');
  if (errorMessage) {
    errorEl.textContent = errorMessage;
    errorEl.classList.remove('hidden');
  } else {
    errorEl.classList.add('hidden');
  }
  document.getElementById('pin-input').focus();
}

function showApp() {
  loginScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  startApp();
}

let started = false;

function startApp() {
  if (started) return;
  started = true;

  fetchInitialState()
    .then(setSnapshot)
    .catch(() => {});

  connectEvents(
    (snapshot) => setSnapshot(snapshot),
    (connected) => {
      setConnected(connected);
      disconnectedBanner.classList.toggle('hidden', connected);
    },
  );

  startRouter();
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = document.getElementById('pin-input').value.trim();
  if (!/^[0-9]{6}$/.test(pin)) {
    showLogin('Enter the 6-digit code.');
    return;
  }
  try {
    await login(pin);
    showApp();
  } catch (error) {
    showLogin(error.message || 'Could not connect.');
  }
});

consumePairingLink();

if (getStoredPassword()) {
  showApp();
} else {
  showLogin();
}

// A stored password can go stale (feature disabled, then re-enabled with a
// fresh one) — api.js dispatches this from both plain fetch() calls and the
// EventSource's error handler whenever the server responds 401/404.
window.addEventListener('beacon-remote-unauthorized', () => {
  clearStoredPassword();
  started = false;
  showLogin('Session expired — enter the code again.');
});
