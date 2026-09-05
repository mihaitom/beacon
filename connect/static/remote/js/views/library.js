// library.js — the phone's library: songs and albums behind one toggle,
// with a single search that applies to whichever half is showing.
//
// Replaced the songs-only view. Same shape as the mobile web UI's
// MobileLibraryView.vue, and as the reference implementation this was
// modelled on (feishin's own remote library page): one request at a time,
// switched by the toggle, rather than both halves fetching in parallel.

import { fetchAlbums, fetchSongs } from '../api.js';
import { navigate, registerRoute } from '../router.js';
import { renderAlbumRow } from '../album-row.js';
import { renderSongRow } from '../song-row.js';

const PAGE_SIZE = 50;

// Everything that differs between the two halves, so the loader below stays
// one function instead of two nearly identical ones.
const VIEWS = {
  albums: {
    empty: 'No albums found',
    failed: 'Couldn’t load albums',
    fetch: fetchAlbums,
    placeholder: 'Search albums…',
    row: renderAlbumRow,
  },
  songs: {
    empty: 'No songs found',
    failed: 'Couldn’t load songs',
    fetch: fetchSongs,
    placeholder: 'Search songs…',
    row: renderSongRow,
  },
};

export function renderLibrary(root) {
  root.innerHTML = `
    <h1 class="view-title">Library</h1>
    <div class="segmented" id="library-toggle">
      <button type="button" class="active" data-view="songs">Songs</button>
      <button type="button" data-view="albums">Albums</button>
    </div>
    <div class="search-field">
      <input type="search" class="search-input" id="library-search" placeholder="Search songs…" />
      <!-- Explicit, not the browser's own: type="search" only draws a clear
           affordance on some platforms (WebKit does, Chrome on Android does
           not), and this is a phone-first app. -->
      <button type="button" class="search-clear hidden" id="library-search-clear"
              aria-label="Clear search"><i class="mdi mdi-close"></i></button>
    </div>
    <div class="list" id="library-list"></div>
    <button class="load-more hidden" id="load-more">Load more</button>
  `;

  const toggle = root.querySelector('#library-toggle');
  const searchInput = root.querySelector('#library-search');
  const searchClear = root.querySelector('#library-search-clear');
  const list = root.querySelector('#library-list');
  const loadMoreBtn = root.querySelector('#load-more');

  let view = 'songs';
  let search = '';
  let offset = 0;
  let total = 0;
  let debounceTimer = null;
  // Bumped on every load; an answer that arrives after a newer request was
  // issued (a fast toggle, a change of search term) is dropped rather than
  // appended to a list it no longer belongs to.
  let requestToken = 0;

  async function load(reset) {
    const config = VIEWS[view];
    if (reset) {
      offset = 0;
      list.innerHTML = '<div class="empty-state">Loading…</div>';
    }
    const token = ++requestToken;
    try {
      const { items, total: newTotal } = await config.fetch(search, offset, PAGE_SIZE);
      if (token !== requestToken) return;
      total = newTotal;
      if (reset) list.innerHTML = '';
      if (reset && !items.length) {
        list.innerHTML = `<div class="empty-state">${config.empty}</div>`;
      }
      for (const item of items) list.appendChild(config.row(item));
      offset += items.length;
      loadMoreBtn.classList.toggle('hidden', offset >= total || items.length === 0);
    } catch {
      if (token !== requestToken) return;
      if (reset) list.innerHTML = `<div class="empty-state">${config.failed}</div>`;
    }
  }

  toggle.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button || button.dataset.view === view) return;
    view = button.dataset.view;
    for (const other of toggle.querySelectorAll('button')) {
      other.classList.toggle('active', other === button);
    }
    // The search deliberately carries over: realising you are in the wrong
    // half is usually what makes you switch, and retyping the term you just
    // entered would be the price of one tap. The clear button next to the
    // field covers the rarer "start over" case.
    searchInput.placeholder = VIEWS[view].placeholder;
    load(true);
  });

  function syncClearButton() {
    searchClear.classList.toggle('hidden', searchInput.value === '');
  }

  searchInput.addEventListener('input', () => {
    syncClearButton();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      search = searchInput.value.trim();
      load(true);
    }, 300);
  });

  searchClear.addEventListener('click', () => {
    clearTimeout(debounceTimer);
    searchInput.value = '';
    syncClearButton();
    // Straight through, no debounce: this is a deliberate press, not a
    // keystroke that another one is probably about to follow.
    search = '';
    load(true);
    searchInput.focus();
  });

  loadMoreBtn.addEventListener('click', () => load(false));

  load(true);

  return () => clearTimeout(debounceTimer);
}

registerRoute('/library', renderLibrary);
// The songs list grew an albums half and became the library. Without this a
// phone whose installed PWA was last left on the old hash lands on a route
// that matches nothing at all and renders a blank page.
registerRoute('/songs', () => navigate('/library'));
