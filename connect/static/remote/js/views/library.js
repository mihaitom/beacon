// library.js — the phone's library: songs, albums and artists behind one
// toggle, browsed rather than searched - the app's MobileLibraryView.vue.
// Each half can be sorted, filtered and shown as a grid of cards, with a
// divider before each letter, year or decade and a grip at the edge to
// drag through those. The heart narrows it to the favourites. Searching is
// the app bar's field (js/top-bar-search.js), as in the app.
//
// The desktop does the sorting, filtering and sectioning, with the app's
// own rules (services/library/libraryBrowse.ts); this page asks for a page
// of the result at a time.
//
// Only a window of the list is in the page: it grows by a page at either
// end as the scroll nears it, and a jump to a section outside it starts a
// new window there - a 20,000-song library is not drawn whole on a phone.

import { fetchLibrary, fireCommand } from '../api.js';
import { navigate, registerRoute } from '../router.js';
import { renderAlbumRow } from '../album-row.js';
import { renderArtistRow } from '../artist-row.js';
import { renderSongRow } from '../song-row.js';
import { renderGridTile } from '../grid-tile.js';
import { createSectionScrubber } from '../section-scrubber.js';
import { openActionSheet } from '../sheet.js';
import { openFilterSheet } from '../filter-sheet.js';
import { state, subscribe } from '../state.js';
import { t } from '../i18n.js';

/** A page divides by every column count a grid has here (2 to 6), so a
 * page loaded above the window lines up with the rows below it. */
const PAGE_SIZE = 60;
/** Tiles at least this wide: two across a phone, more on a tablet - the
 * app's own GRID_MIN_TILE and GRID_GAP. */
const GRID_MIN_TILE = 140;
const GRID_GAP = 12;
/** How far ahead of either end of the window the next page is asked for. */
const LOAD_AHEAD_PX = 800;

const VIEWS = {
  songs: {
    tile: 'song',
    empty: 'library.noSongs',
    favoritesEmpty: 'favorites.noSongs',
    failed: 'library.failedSongs',
  },
  albums: {
    tile: 'album',
    empty: 'library.noAlbums',
    favoritesEmpty: 'favorites.noAlbums',
    failed: 'library.failedAlbums',
  },
  artists: {
    tile: 'artist',
    empty: 'library.noArtists',
    favoritesEmpty: 'favorites.noArtists',
    failed: 'library.failedArtists',
  },
};

/** For this visit to the app, not stored: the tab bar opens the library at
 * its bare address, and someone who lives in their favourites should find
 * them there again - but a filter nobody remembers switching on, found
 * after a reload, reads as missing music. */
const session = {
  favoritesOnly: false,
  filters: { songs: {}, albums: {}, artists: {} },
};

function readStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Applies for this visit only; not worth surfacing.
  }
}

/** The order and the layout are remembered per half on this phone. With no
 * order of its own the list comes in the one Beacon last browsed by. */
const sortKey = (view) => `beacon_remote_sort_${view}`;
const gridKey = (view) => `beacon_remote_grid_${view}`;

export function renderLibrary(root, _params, queryParams) {
  root.innerHTML = `
    <h1 class="view-title" id="library-title"></h1>
    <div class="library-controls" id="library-controls">
      <div class="segmented" id="library-toggle">
        <button type="button" data-view="songs">${t('library.songs')}</button>
        <button type="button" data-view="albums">${t('library.albums')}</button>
        <button type="button" data-view="artists">${t('library.artists')}</button>
      </div>
      <div class="library-toolbar">
        <button type="button" class="library-tool library-favorites" id="library-favorites"
                title="${t('library.favoritesOnly')}" aria-label="${t('library.favoritesOnly')}"
                aria-pressed="false"><i class="mdi mdi-heart-outline"></i></button>
        <div class="library-layout" role="group">
          <button type="button" class="library-tool" data-layout="grid"
                  title="${t('library.layoutGrid')}" aria-label="${t('library.layoutGrid')}">
            <i class="mdi mdi-view-grid-outline"></i></button>
          <button type="button" class="library-tool" data-layout="list"
                  title="${t('library.layoutList')}" aria-label="${t('library.layoutList')}">
            <i class="mdi mdi-view-list"></i></button>
        </div>
        <button type="button" class="library-tool library-filter hidden" id="library-filter"
                title="${t('library.filter')}" aria-label="${t('library.filter')}">
          <i class="mdi mdi-filter-variant"></i><span class="library-filter__count hidden"></span>
        </button>
        <div class="library-sort">
          <button type="button" class="library-sort__pick" id="library-sort"
                  aria-label="${t('library.sortBy')}">
            <i class="mdi mdi-sort"></i><span class="library-sort__label"></span>
          </button>
          <button type="button" class="library-sort__direction" id="library-direction">
            <i class="mdi mdi-arrow-up"></i></button>
        </div>
      </div>
    </div>
    <div class="library-list" id="library-list"></div>
    <div class="empty-state hidden" id="library-empty"></div>
  `;

  const title = root.querySelector('#library-title');
  const controls = root.querySelector('#library-controls');
  const toggle = root.querySelector('#library-toggle');
  const favoritesBtn = root.querySelector('#library-favorites');
  const layoutBtns = root.querySelectorAll('[data-layout]');
  const filterBtn = root.querySelector('#library-filter');
  const filterCount = filterBtn.querySelector('.library-filter__count');
  const sortBtn = root.querySelector('#library-sort');
  const sortLabel = sortBtn.querySelector('.library-sort__label');
  const directionBtn = root.querySelector('#library-direction');
  const list = root.querySelector('#library-list');
  const emptyEl = root.querySelector('#library-empty');

  const tab = queryParams?.get('tab');
  let view = VIEWS[tab] ? tab : 'songs';
  if (queryParams?.get('favorites') === '1') session.favoritesOnly = true;

  // The answer about the half as a whole: its order, the orders on offer,
  // its sections and its filter menu. Replaced by every first page.
  let meta = null;
  let grid = false;
  let columns = 2;
  // The window [start, end) of the filtered list that is in the page.
  let start = 0;
  let end = 0;
  let total = 0;
  // Bumped whenever the window is thrown away; an answer for an older one
  // is dropped rather than drawn into a list it no longer belongs to.
  let token = 0;
  let loadingUp = false;
  let loadingDown = false;
  // One block per section in the window, each with its divider (when the
  // window holds the section's start) and its rows or tiles.
  let blocks = [];

  // A prepended page keeps what is on screen where it is by moving the
  // scroll itself; the browser's own scroll anchoring would move it again.
  root.classList.add('library-scroller');

  const scrubber = createSectionScrubber({
    scroller: root,
    topInset: () => controls.offsetHeight,
    onSelect: jumpTo,
  });

  function syncControls() {
    title.textContent = session.favoritesOnly ? t('favorites.title') : t('library.title');
    for (const button of toggle.querySelectorAll('button')) {
      button.classList.toggle('active', button.dataset.view === view);
    }
    // A server without favourites never shows the heart, so nor may it be
    // left filtering by one switched on before.
    const canFavorite = state.snapshot.favorites_supported !== false;
    favoritesBtn.classList.toggle('hidden', !canFavorite);
    favoritesBtn.classList.toggle('active', session.favoritesOnly);
    favoritesBtn.setAttribute('aria-pressed', String(session.favoritesOnly));
    favoritesBtn.querySelector('i').className = session.favoritesOnly
      ? 'mdi mdi-heart'
      : 'mdi mdi-heart-outline';
    for (const button of layoutBtns) {
      const on = (button.dataset.layout === 'grid') === grid;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
    const fields = meta?.filter_fields ?? [];
    filterBtn.classList.toggle('hidden', !fields.length);
    const count = meta?.filter_count ?? 0;
    filterBtn.classList.toggle('active', count > 0);
    filterCount.classList.toggle('hidden', !count);
    filterCount.textContent = String(count);
    const sort = meta?.sort;
    sortLabel.textContent =
      meta?.sort_options.find((option) => option.value === sort?.key)?.label ?? '';
    const descending = sort?.direction === 'desc';
    directionBtn.querySelector('i').className = `mdi ${descending ? 'mdi-arrow-down' : 'mdi-arrow-up'}`;
    const directionLabel = t(descending ? 'library.sortDesc' : 'library.sortAsc');
    directionBtn.title = directionLabel;
    directionBtn.setAttribute('aria-label', directionLabel);
    sortBtn.disabled = !meta;
    directionBtn.disabled = !meta;
  }

  /** The half and the heart in the address, so coming back from an album
   * finds them still there. Replaced, not pushed: a switch of half is not
   * a step anyone means to walk back through. */
  function rememberPlace() {
    const params = new URLSearchParams();
    if (view !== 'songs') params.set('tab', view);
    if (session.favoritesOnly) params.set('favorites', '1');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}#/library${query ? `?${query}` : ''}`);
  }

  function measureColumns() {
    const width = list.clientWidth || root.clientWidth - 32;
    columns = Math.max(2, Math.floor((width + GRID_GAP) / (GRID_MIN_TILE + GRID_GAP)));
    list.style.setProperty('--grid-columns', String(columns));
  }

  // ── Sections ──

  /** The sections the filtered list holds, by where each starts. */
  function startedSections() {
    return (meta?.sections ?? []).filter((section) => section.offset !== null);
  }

  /** The section an item of the filtered list is in, or null for an order
   * without sections. */
  function sectionAt(index) {
    let found = null;
    for (const section of startedSections()) {
      if (section.offset > index) break;
      found = section;
    }
    return found;
  }

  function blockFor(section, { before = false } = {}) {
    const key = section?.key ?? null;
    let block = blocks.find((candidate) => candidate.key === key);
    if (block) return block;
    const el = document.createElement('div');
    el.className = 'library-block';
    const items = document.createElement('div');
    items.className = grid ? 'library-grid' : 'list';
    el.appendChild(items);
    block = { key, section, el, items, divider: null };
    if (before) {
      blocks.unshift(block);
      list.prepend(el);
    } else {
      blocks.push(block);
      list.appendChild(el);
    }
    return block;
  }

  function addDivider(block) {
    if (block.divider || !block.section) return;
    const divider = document.createElement('div');
    divider.className = 'letter-divider';
    divider.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'letter-divider__label';
    label.textContent = block.section.label;
    divider.appendChild(label);
    block.divider = divider;
    block.el.prepend(divider);
  }

  /** Placeholders before the first tile when the window starts inside a
   * section: a tile's column is its place within the section, and without
   * them every row above it would shift once the rest is loaded. */
  function syncFillers() {
    list.querySelectorAll('.grid-tile--filler').forEach((filler) => filler.remove());
    const first = blocks[0];
    if (!grid || !first?.section || first.section.offset >= start) return;
    const count = (start - first.section.offset) % columns;
    for (let i = 0; i < count; i++) {
      const filler = document.createElement('div');
      filler.className = 'grid-tile grid-tile--filler';
      filler.setAttribute('aria-hidden', 'true');
      first.items.prepend(filler);
    }
  }

  // ── Rows ──

  function renderItem(item, index) {
    let element;
    if (grid) {
      element = renderGridTile(VIEWS[view].tile, item, {
        onPlay: () => playSong(item, index),
        detail: item.sort_detail,
      });
    } else if (view === 'songs') {
      element = renderSongRow(item, { onPlay: () => playSong(item, index), detail: item.sort_detail });
    } else if (view === 'albums') {
      element = renderAlbumRow(item, { detail: item.sort_detail });
    } else {
      element = renderArtistRow(item, { detail: item.sort_detail });
    }
    element.dataset.index = String(index);
    return element;
  }

  /** The tapped song alone, not the list around it: the whole catalogue is
   * not a sequence anyone meant to hear in order. Favourites are the
   * exception - a collection somebody put together, which plays on after
   * the tapped song, in the order and through the filter shown here. */
  function playSong(song, index) {
    if (session.favoritesOnly) {
      fireCommand('play-favorites', {
        songId: song.id,
        startIndex: index,
        sort: meta?.sort,
        filters: session.filters[view],
      });
      return;
    }
    fireCommand('play-song', { songId: song.id });
  }

  function append(items, from) {
    items.forEach((item, i) => {
      const index = from + i;
      const section = sectionAt(index);
      const block = blockFor(section);
      if (section && section.offset === index) addDivider(block);
      block.items.appendChild(renderItem(item, index));
    });
  }

  function prepend(items, from) {
    for (let i = items.length - 1; i >= 0; i--) {
      const index = from + i;
      const section = sectionAt(index);
      const block = blockFor(section, { before: true });
      const element = renderItem(items[i], index);
      block.items.prepend(element);
      if (section && section.offset === index) addDivider(block);
    }
  }

  // ── Loading ──

  function request(offset, limit) {
    return fetchLibrary(view, {
      sort: readStored(sortKey(view)),
      favorites: session.favoritesOnly,
      filters: session.filters[view],
      offset,
      limit,
    });
  }

  function showEmpty(key, hint) {
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = t(key);
    if (hint) {
      const line = document.createElement('div');
      line.className = 'empty-state__hint';
      line.textContent = t(hint);
      emptyEl.appendChild(line);
    }
  }

  function clearList() {
    token++;
    loadingUp = false;
    loadingDown = false;
    // Nothing to grow at either end until the new window's first page is
    // in: a scroll meanwhile would page on from the old one.
    start = 0;
    end = 0;
    total = 0;
    blocks = [];
    list.innerHTML = '';
    emptyEl.classList.add('hidden');
  }

  /** A fresh window from `offset` - the top, or the section jumped to. */
  async function loadFrom(offset, { scrollToStart = false } = {}) {
    clearList();
    const mine = token;
    if (!meta) showEmpty('common.loading');
    let answer;
    try {
      answer = await request(offset, PAGE_SIZE);
    } catch {
      if (mine !== token) return;
      list.innerHTML = '';
      showEmpty(VIEWS[view].failed);
      return;
    }
    if (mine !== token) return;
    emptyEl.classList.add('hidden');
    meta = answer;
    // The phone's own copy of what the desktop kept: a field the half no
    // longer offers drops out of the picks too.
    session.filters[view] = answer.filters ?? {};
    total = answer.total;
    start = Math.min(offset, total);
    end = start + answer.items.length;
    append(answer.items, start);
    syncFillers();
    syncControls();
    scrubber.setSections(
      (answer.sections ?? []).map((section) => ({
        key: section.key,
        short: section.short,
        available: section.offset !== null,
      })),
    );
    if (!total) {
      if (session.favoritesOnly) showEmpty(VIEWS[view].favoritesEmpty, 'favorites.emptyHint');
      else showEmpty(VIEWS[view].empty);
    }
    if (scrollToStart) scrollToBlock(blocks[0]);
    else root.scrollTop = 0;
    onScroll();
  }

  async function loadDown() {
    if (loadingDown || end >= total) return;
    loadingDown = true;
    const mine = token;
    try {
      const answer = await request(end, PAGE_SIZE);
      if (mine !== token) return;
      append(answer.items, end);
      end += answer.items.length;
      total = answer.total;
      if (!answer.items.length) end = total;
    } catch {
      // Tried again on the next scroll.
    } finally {
      if (mine === token) loadingDown = false;
    }
    if (mine === token) onScroll();
  }

  async function loadUp() {
    if (loadingUp || start <= 0) return;
    loadingUp = true;
    const mine = token;
    const from = Math.max(0, start - PAGE_SIZE);
    try {
      const answer = await request(from, start - from);
      if (mine !== token) return;
      const before = root.scrollHeight;
      prepend(answer.items, from);
      start = from;
      syncFillers();
      root.scrollTop += root.scrollHeight - before;
    } catch {
      // Tried again on the next scroll.
    } finally {
      if (mine === token) loadingUp = false;
    }
    if (mine === token) onScroll();
  }

  // ── Scrolling ──

  /** Onto the section's divider, clear of the sticky controls. */
  function scrollToBlock(block) {
    if (!block) return;
    const offset = block.el.getBoundingClientRect().top - root.getBoundingClientRect().top;
    root.scrollTop += offset - controls.offsetHeight;
  }

  function jumpTo(key) {
    const section = startedSections().find((candidate) => candidate.key === key);
    if (!section) return;
    scrubber.setActive(key);
    const block = blocks.find((candidate) => candidate.key === key);
    if (block?.divider) {
      scrollToBlock(block);
      return;
    }
    void loadFrom(section.offset, { scrollToStart: true });
  }

  /** The first item under the sticky controls. */
  function topItem() {
    const box = root.getBoundingClientRect();
    const y = box.top + controls.offsetHeight + 4;
    const x = box.left + Math.min(box.width / 2, 120);
    const hit = document.elementFromPoint(x, y);
    // A divider up there belongs to the section whose first item follows it.
    return (
      hit?.closest?.('[data-index]') ??
      hit?.closest?.('.library-block')?.querySelector('[data-index]') ??
      null
    );
  }

  let scrollFrame = 0;
  function onScroll() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (!root.isConnected) return;
      const top = topItem();
      const index = top ? Number(top.dataset.index) : start;
      scrubber.setActive(sectionAt(index)?.key ?? null);
      scrubber.setProgress(total > 1 ? index / (total - 1) : 0);
      const fromBottom = root.scrollHeight - root.scrollTop - root.clientHeight;
      if (fromBottom < LOAD_AHEAD_PX) void loadDown();
      if (root.scrollTop < LOAD_AHEAD_PX + controls.offsetHeight) void loadUp();
    });
  }

  // ── Controls ──

  function reload() {
    meta = meta ? { ...meta, sections: [] } : null;
    void loadFrom(0);
  }

  function switchView(next) {
    view = next;
    meta = null;
    grid = readStored(gridKey(view)) === true;
    measureColumns();
    syncControls();
    rememberPlace();
    reload();
  }

  toggle.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button || button.dataset.view === view) return;
    switchView(button.dataset.view);
  });

  favoritesBtn.addEventListener('click', () => {
    session.favoritesOnly = !session.favoritesOnly;
    syncControls();
    rememberPlace();
    reload();
  });

  for (const button of layoutBtns) {
    button.addEventListener('click', () => {
      const next = button.dataset.layout === 'grid';
      if (next === grid) return;
      grid = next;
      writeStored(gridKey(view), grid);
      measureColumns();
      syncControls();
      // Same window, drawn the other way: where the reader was matters
      // more than redrawing from the top.
      const index = Number(topItem()?.dataset.index ?? start);
      const section = sectionAt(index);
      void loadFrom(section ? section.offset : 0, { scrollToStart: Boolean(section) });
    });
  }

  filterBtn.addEventListener('click', () => {
    if (!meta) return;
    openFilterSheet({
      fields: meta.filter_fields,
      filters: session.filters[view],
      onChange: (filters) => {
        session.filters[view] = filters;
        reload();
      },
    });
  });

  sortBtn.addEventListener('click', () => {
    if (!meta) return;
    openActionSheet(
      meta.sort_options.map((option) => ({
        label: option.label,
        icon: option.value === meta.sort.key ? 'mdi-check' : 'mdi-blank',
        onSelect: () => {
          if (option.value === meta.sort.key) return;
          // Each order starts the way the app's does: names from the front,
          // figures biggest first. The desktop knows which is which.
          writeStored(sortKey(view), { key: option.value, direction: null });
          reload();
        },
      })),
      { title: t('library.sortBy') },
    );
  });

  directionBtn.addEventListener('click', () => {
    if (!meta) return;
    const { key, direction } = meta.sort;
    writeStored(sortKey(view), { key, direction: direction === 'asc' ? 'desc' : 'asc' });
    reload();
  });

  root.addEventListener('scroll', onScroll, { passive: true });
  const onResize = () => {
    const before = columns;
    measureColumns();
    if (grid && columns !== before) syncFillers();
  };
  window.addEventListener('resize', onResize);
  const unsubscribe = subscribe(syncControls);

  grid = readStored(gridKey(view)) === true;
  measureColumns();
  syncControls();
  rememberPlace();
  reload();

  return () => {
    token++;
    cancelAnimationFrame(scrollFrame);
    root.classList.remove('library-scroller');
    root.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    unsubscribe();
    scrubber.destroy();
  };
}

registerRoute('/library', renderLibrary);
// The favourites tab became the library's heart filter; an old bookmark
// lands on the library with the filter on.
registerRoute('/favorites', () => navigate('/library?favorites=1'));
// The songs list grew an albums half and became the library. Without this a
// phone whose installed PWA was last left on the old hash lands on a route
// that matches nothing at all and renders a blank page.
registerRoute('/songs', () => navigate('/library'));
