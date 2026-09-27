// art.js — shared cover-art/favicon element builder.
//
// Real <img> elements, not CSS background-image — matches the desktop
// app's own CoverArt.vue, which always renders through a real <img>
// (Vuetify's v-img) rather than a background-image div. Some radio
// stations' SVG favicons were showing up colorless here specifically
// because of that difference (an SVG referenced from a CSS background can
// render its fill colors differently, or lose them entirely, compared to
// the same file loaded as a real image) — an <img> also gets a proper
// error event to fall back to the placeholder icon on a broken/404 URL,
// which the old background-image version had no way to detect at all.

import { getStoredPassword } from './api.js';

// The desktop sends connect's image endpoints without a credential: an
// <img> cannot send the X-Remote-Password header, so the password rides in
// the query instead, and it has to be this phone's own. The desktop's copy
// is gone after every reload of the app, while this one stays valid.
function authenticated(url) {
  if (!url.startsWith('/remote/')) return url;
  const password = getStoredPassword();
  if (!password) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}password=${encodeURIComponent(password)}`;
}

export function setArt(container, url, fallbackIconClass) {
  container.innerHTML = '';
  if (!url) {
    if (fallbackIconClass) container.innerHTML = `<i class="mdi ${fallbackIconClass}"></i>`;
    return;
  }
  const img = document.createElement('img');
  img.src = authenticated(url);
  img.alt = '';
  img.addEventListener('error', () => {
    container.innerHTML = fallbackIconClass ? `<i class="mdi ${fallbackIconClass}"></i>` : '';
  });
  container.appendChild(img);
}

export function createArt(url, fallbackIconClass, className = 'row-art') {
  const art = document.createElement('div');
  art.className = className;
  setArt(art, url, fallbackIconClass);
  return art;
}
