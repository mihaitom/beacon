// top-bar-search.js — the search field in the app bar, as the app's
// MobileTopBarSearch.vue: always a field, searching everything at once on
// the search page. Elsewhere it waits for the keyboard's search key, so
// typing does not pull the page away; on the search page the results
// follow as you type. Now Playing keeps the name in the bar instead: its
// own buttons sit there, and it is not a page to search from.

import { navigate } from './router.js';
import { t } from './i18n.js';

const LIVE_DELAY_MS = 250;

function onSearchPage() {
  return location.hash.replace(/^#/, '').split('?')[0] === '/search';
}

function queryInAddress() {
  return new URLSearchParams(location.hash.split('?')[1] || '').get('q') ?? '';
}

export function initTopBarSearch() {
  const bar = document.querySelector('.app-bar');
  // A re-login starts the app again; the bar outlives it.
  if (bar.querySelector('.app-bar__search')) return;
  const title = bar.querySelector('.app-bar__title');
  const form = document.createElement('form');
  form.className = 'app-bar__search';
  form.setAttribute('role', 'search');
  form.innerHTML = `
    <i class="mdi mdi-magnify app-bar__search-icon"></i>
    <input type="search" class="app-bar__search-input" enterkeyhint="search"
           autocomplete="off" />
    <button type="button" class="app-bar__search-clear hidden"><i class="mdi mdi-close"></i></button>
  `;
  title.after(form);
  const input = form.querySelector('input');
  const clear = form.querySelector('.app-bar__search-clear');
  input.placeholder = t('search.label');
  input.setAttribute('aria-label', t('search.label'));
  clear.setAttribute('aria-label', t('common.clearSearch'));

  let liveTimer = null;

  function syncClear() {
    clear.classList.toggle('hidden', input.value === '');
  }

  /** On the search page itself the term replaces the one in the address
   * (one step back still leaves the search) and the page follows it. */
  function showResults(query) {
    const params = new URLSearchParams({ q: query });
    history.replaceState(null, '', `${location.pathname}#/search?${params}`);
    window.dispatchEvent(new CustomEvent('beacon-remote-search', { detail: { q: query } }));
  }

  function syncToRoute() {
    const path = location.hash.replace(/^#/, '').split('?')[0];
    const nowPlaying = path === '/now-playing';
    title.classList.toggle('hidden', !nowPlaying);
    form.classList.toggle('hidden', nowPlaying);
    // Picks up a term that came another way (back, a link) on the way in,
    // and lets go of it on the way out.
    if (document.activeElement !== input) input.value = onSearchPage() ? queryInAddress() : '';
    syncClear();
  }

  input.addEventListener('input', () => {
    syncClear();
    if (!onSearchPage()) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => showResults(input.value.trim()), LIVE_DELAY_MS);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(liveTimer);
    const query = input.value.trim();
    // Out of the way of the results: the keyboard covers half of them.
    input.blur();
    if (onSearchPage()) showResults(query);
    else if (query) navigate(`/search?${new URLSearchParams({ q: query })}`);
  });

  clear.addEventListener('click', () => {
    clearTimeout(liveTimer);
    input.value = '';
    syncClear();
    if (onSearchPage()) showResults('');
    input.focus();
  });

  window.addEventListener('hashchange', syncToRoute);
  syncToRoute();
}
