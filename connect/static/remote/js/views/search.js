// search.js — the search page, fed by the app bar's field
// (js/top-bar-search.js): artists, albums, songs, playlists and radio
// stations at once, the kind that fits best on top - the app's
// MobileSearchView.vue, over the same matcher on the desktop.
//
// A handful of each kind rather than every match: this is for landing on
// the one thing being looked for. "Show all" lists every match of a kind.

import { fetchSearch } from '../api.js';
import { navigate, registerRoute } from '../router.js';
import { renderAlbumRow } from '../album-row.js';
import { renderArtistRow } from '../artist-row.js';
import { renderSongRow } from '../song-row.js';
import { renderPlaylistRow } from '../playlist-row.js';
import { renderRadioRow } from '../radio-row.js';
import { n, t } from '../i18n.js';

const PAGE_SIZE = 50;
const LOAD_AHEAD_PX = 800;

/** The kinds with a "show all": the ones that run long enough for it. */
const LISTED_KINDS = ['songs', 'albums', 'artists'];

const TITLE = {
  artists: 'search.artists',
  albums: 'search.albums',
  songs: 'search.songs',
  playlists: 'search.playlists',
  stations: 'search.stations',
};

/** One song plays on its own, not the matches around it - the same rule as
 * the app's search page; song-row.js's tap does exactly that. */
function renderRow(kind, item) {
  switch (kind) {
    case 'artists':
      return renderArtistRow(item);
    case 'albums':
      return renderAlbumRow(item);
    case 'songs':
      return renderSongRow(item);
    case 'playlists':
      return renderPlaylistRow(item);
    default:
      return renderRadioRow(item);
  }
}

function emptyState(text, hint) {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.textContent = text;
  if (hint) {
    const line = document.createElement('div');
    line.className = 'empty-state__hint';
    line.textContent = hint;
    el.appendChild(line);
  }
  return el;
}

export function renderSearch(root, _params, queryParams) {
  let query = (queryParams?.get('q') ?? '').trim();
  const kind = LISTED_KINDS.includes(queryParams?.get('kind')) ? queryParams.get('kind') : null;

  root.innerHTML = `
    <h1 class="view-title" id="search-title"></h1>
    <div id="search-body"></div>
  `;
  const titleEl = root.querySelector('#search-title');
  const body = root.querySelector('#search-body');
  let token = 0;

  function setTitle() {
    titleEl.textContent = query ? t('search.resultsFor', { query }) : t('search.label');
  }

  async function showOverview() {
    setTitle();
    const mine = ++token;
    if (!query) {
      body.replaceChildren(emptyState(t('search.everythingHint')));
      return;
    }
    // The last results stay up until the next ones are in, so typing does
    // not blink the page empty on every letter.
    if (!body.childElementCount) body.replaceChildren(emptyState(t('search.searching')));
    let answer;
    try {
      answer = await fetchSearch(query);
    } catch {
      if (mine === token) body.replaceChildren(emptyState(t('search.failed')));
      return;
    }
    if (mine !== token) return;
    if (!answer.sections.length) {
      body.replaceChildren(
        emptyState(t('search.noResults', { query }), t('search.noResultsHint')),
      );
      return;
    }
    const sections = answer.sections.map((section) => {
      const el = document.createElement('section');
      el.className = 'search-section';
      const head = document.createElement('div');
      head.className = 'search-section__head';
      const heading = document.createElement('h2');
      heading.className = 'section-heading';
      heading.textContent = t(TITLE[section.kind]);
      head.appendChild(heading);
      if (LISTED_KINDS.includes(section.kind) && section.total > section.items.length) {
        const all = document.createElement('button');
        all.type = 'button';
        all.className = 'search-section__all';
        all.textContent = t('library.showAllMatches', { count: n(section.total) });
        all.addEventListener('click', () =>
          navigate(`/search?${new URLSearchParams({ q: query, kind: section.kind })}`),
        );
        head.appendChild(all);
      }
      const rows = document.createElement('div');
      rows.className = 'list';
      for (const item of section.items) rows.appendChild(renderRow(section.kind, item));
      el.append(head, rows);
      return el;
    });
    body.replaceChildren(...sections);
  }

  /** One kind's every match, paged in as the scroll nears the end. */
  function showKind() {
    setTitle();
    const heading = document.createElement('h2');
    heading.className = 'section-heading search-kind';
    heading.textContent = t(TITLE[kind]);
    const rows = document.createElement('div');
    rows.className = 'list';
    body.replaceChildren(heading, rows, emptyState(t('search.searching')));
    let loaded = 0;
    let total = Infinity;
    let loading = false;
    const mine = ++token;

    async function more() {
      if (loading || loaded >= total) return;
      loading = true;
      try {
        const answer = await fetchSearch(query, { kind, offset: loaded, limit: PAGE_SIZE });
        if (mine !== token) return;
        body.querySelector('.empty-state')?.remove();
        total = answer.total;
        for (const item of answer.items) rows.appendChild(renderRow(kind, item));
        loaded += answer.items.length;
        if (!answer.items.length) total = loaded;
        if (!total) body.appendChild(emptyState(t('search.noResults', { query })));
      } catch {
        if (mine === token && !loaded) {
          body.querySelector('.empty-state')?.remove();
          body.appendChild(emptyState(t('search.failed')));
        }
        total = loaded;
      } finally {
        loading = false;
      }
      if (mine === token) check();
    }

    function check() {
      if (root.scrollHeight - root.scrollTop - root.clientHeight < LOAD_AHEAD_PX) void more();
    }
    onScroll = check;
    void more();
  }

  let onScroll = () => {};
  const scrolled = () => onScroll();
  root.addEventListener('scroll', scrolled, { passive: true });

  // The app bar's field, typing on this page (see js/top-bar-search.js).
  function onLiveSearch(event) {
    query = event.detail.q.trim();
    if (kind) {
      // A term changed on a "show all" goes back to every kind.
      navigate(`/search?${new URLSearchParams({ q: query })}`);
      return;
    }
    void showOverview();
  }
  window.addEventListener('beacon-remote-search', onLiveSearch);

  if (kind && query) showKind();
  else void showOverview();

  return () => {
    token++;
    root.removeEventListener('scroll', scrolled);
    window.removeEventListener('beacon-remote-search', onLiveSearch);
  };
}

registerRoute('/search', renderSearch);
