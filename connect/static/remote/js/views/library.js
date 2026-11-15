// library.js — the phone's library: songs, albums and artists behind one
// toggle, with a single search that applies to whichever half is showing,
// and the heart in the search field narrowing it to favourites.
//
// Same shape as the mobile web UI's MobileLibraryView.vue: favourites are
// the library narrowed down rather than a tab of their own, so the same
// three halves, rows and search all come along.

import { fetchAlbums, fetchArtists, fetchFavorites, fetchSongs, fireCommand } from '../api.js';
import { navigate, registerRoute } from '../router.js';
import { renderAlbumRow } from '../album-row.js';
import { renderArtistRow } from '../artist-row.js';
import { renderSongRow } from '../song-row.js';
import { t } from '../i18n.js';

const PAGE_SIZE = 50;

// Everything that differs between the three halves, so the loader below
// stays one function instead of three nearly identical ones.
const VIEWS = {
  albums: {
    empty: 'library.noAlbums',
    favoritesEmpty: 'favorites.noAlbums',
    failed: 'library.failedAlbums',
    fetch: fetchAlbums,
    placeholder: 'library.searchAlbums',
    row: renderAlbumRow,
    matches: (album, query) => matchesAll(query, [album.name, album.artist]),
  },
  artists: {
    empty: 'library.noArtists',
    favoritesEmpty: 'favorites.noArtists',
    failed: 'library.failedArtists',
    fetch: fetchArtists,
    placeholder: 'library.searchArtists',
    row: renderArtistRow,
    matches: (artist, query) => matchesAll(query, [artist.name]),
  },
  songs: {
    empty: 'library.noSongs',
    favoritesEmpty: 'favorites.noSongs',
    failed: 'library.failedSongs',
    fetch: fetchSongs,
    placeholder: 'library.searchSongs',
    row: renderSongRow,
    matches: (song, query) => matchesAll(query, [song.title, song.artist, song.album]),
  },
};

/** Every term somewhere in the row's own text, the way the app's
 * matchesAllTerms() narrows a list. */
function matchesAll(query, fields) {
  const text = fields.filter(Boolean).join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => text.includes(term));
}

export function renderLibrary(root, _params, queryParams) {
  root.innerHTML = `
    <h1 class="view-title">${t('library.title')}</h1>
    <div class="segmented" id="library-toggle">
      <button type="button" class="active" data-view="songs">${t('library.songs')}</button>
      <button type="button" data-view="albums">${t('library.albums')}</button>
      <button type="button" data-view="artists">${t('library.artists')}</button>
    </div>
    <div class="search-field">
      <input type="search" class="search-input" id="library-search" placeholder="${t('library.searchSongs')}" />
      <button type="button" class="search-favorite" id="library-favorites"
              title="${t('library.favoritesOnly')}" aria-label="${t('library.favoritesOnly')}"
              aria-pressed="false"><i class="mdi mdi-heart-outline"></i></button>
      <!-- Explicit, not the browser's own: type="search" only draws a clear
           affordance on some platforms (WebKit does, Chrome on Android does
           not), and this is a phone-first app. -->
      <button type="button" class="search-clear hidden" id="library-search-clear"
              aria-label="${t('common.clearSearch')}"><i class="mdi mdi-close"></i></button>
    </div>
    <div class="list" id="library-list"></div>
    <button class="load-more hidden" id="load-more">${t('common.loadMore')}</button>
  `;

  const toggle = root.querySelector('#library-toggle');
  const searchInput = root.querySelector('#library-search');
  const searchClear = root.querySelector('#library-search-clear');
  const favoritesBtn = root.querySelector('#library-favorites');
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
  // Favourites arrive in one answer — a favourites list is small enough not
  // to page — and are filtered on the phone, so switching among the three
  // halves costs no request.
  let favoritesOnly = queryParams?.get('favorites') === '1';
  let favorites = null;
  let favoritesError = false;

  function syncFavoritesButton() {
    favoritesBtn.classList.toggle('active', favoritesOnly);
    favoritesBtn.setAttribute('aria-pressed', String(favoritesOnly));
    favoritesBtn.querySelector('i').className = favoritesOnly
      ? 'mdi mdi-heart'
      : 'mdi mdi-heart-outline';
  }

  function syncClearButton() {
    searchClear.classList.toggle('hidden', searchInput.value === '');
  }

  function emptyHtml(key) {
    return `<div class="empty-state">${t(key)}</div>`;
  }

  function renderFavorites() {
    // The rows have their own search placeholder per half.
    searchInput.placeholder = t(VIEWS[view].placeholder);
    list.innerHTML = '';
    loadMoreBtn.classList.add('hidden');

    if (favoritesError) {
      list.innerHTML = emptyHtml('favorites.failed');
      return;
    }
    if (!favorites) {
      list.innerHTML = emptyHtml('common.loading');
      return;
    }

    const config = VIEWS[view];
    const items = (favorites[view] ?? []).filter(
      (item) => !search || config.matches(item, search),
    );
    if (!items.length) {
      list.innerHTML = emptyHtml(config.favoritesEmpty);
      return;
    }
    if (view === 'songs') {
      // A collection somebody put together, which plays on after the
      // tapped song — the same call the app's own favourites make.
      items.forEach((song, index) => {
        list.appendChild(
          renderSongRow(song, {
            onPlay: () => fireCommand('play-favorites', { songId: song.id, startIndex: index }),
          }),
        );
      });
      return;
    }
    for (const item of items) list.appendChild(config.row(item));
  }

  async function loadFavorites() {
    if (favorites) {
      renderFavorites();
      return;
    }
    favoritesError = false;
    list.innerHTML = emptyHtml('common.loading');
    try {
      favorites = await fetchFavorites();
    } catch {
      favoritesError = true;
    }
    renderFavorites();
  }

  async function load(reset) {
    const config = VIEWS[view];
    if (reset) {
      offset = 0;
      list.innerHTML = emptyHtml('common.loading');
    }
    const token = ++requestToken;
    try {
      const { items, total: newTotal } = await config.fetch(search, offset, PAGE_SIZE);
      if (token !== requestToken) return;
      total = newTotal;
      if (reset) list.innerHTML = '';
      if (reset && !items.length) {
        list.innerHTML = emptyHtml(config.empty);
      }
      for (const item of items) list.appendChild(config.row(item));
      offset += items.length;
      loadMoreBtn.classList.toggle('hidden', offset >= total || items.length === 0);
    } catch {
      if (token !== requestToken) return;
      if (reset) list.innerHTML = emptyHtml(config.failed);
    }
  }

  function reload(reset = true) {
    if (favoritesOnly) void loadFavorites();
    else void load(reset);
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
    searchInput.placeholder = t(VIEWS[view].placeholder);
    search = searchInput.value.trim();
    reload();
  });

  searchInput.addEventListener('input', () => {
    syncClearButton();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      search = searchInput.value.trim();
      reload();
    }, 300);
  });

  searchClear.addEventListener('click', () => {
    clearTimeout(debounceTimer);
    searchInput.value = '';
    syncClearButton();
    // Straight through, no debounce: this is a deliberate press, not a
    // keystroke that another one is probably about to follow.
    search = '';
    reload();
    searchInput.focus();
  });

  favoritesBtn.addEventListener('click', () => {
    favoritesOnly = !favoritesOnly;
    syncFavoritesButton();
    // A switch made here is in the address too, so going into an album and
    // back finds the library still narrowed down.
    const url = new URL(location.href);
    if (favoritesOnly) url.hash = '#/library?favorites=1';
    else url.hash = '#/library';
    history.replaceState(null, '', url);
    reload();
  });

  loadMoreBtn.addEventListener('click', () => load(false));

  syncFavoritesButton();
  reload();

  return () => clearTimeout(debounceTimer);
}

registerRoute('/library', renderLibrary);
// The favourites tab became the library's heart filter (see above); an old
// bookmark lands on the library with the filter on.
registerRoute('/favorites', () => navigate('/library?favorites=1'));
// The songs list grew an albums half and became the library. Without this a
// phone whose installed PWA was last left on the old hash lands on a route
// that matches nothing at all and renders a blank page.
registerRoute('/songs', () => navigate('/library'));
