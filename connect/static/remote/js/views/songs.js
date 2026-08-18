import { fetchSongs } from '../api.js';
import { registerRoute } from '../router.js';
import { renderSongRow } from '../song-row.js';

const PAGE_SIZE = 50;

export function renderSongs(root) {
  root.innerHTML = `
    <input type="search" class="search-input" id="song-search" placeholder="Search songs…" />
    <div class="list" id="song-list"></div>
    <button class="load-more hidden" id="load-more">Load more</button>
  `;

  const searchInput = root.querySelector('#song-search');
  const list = root.querySelector('#song-list');
  const loadMoreBtn = root.querySelector('#load-more');

  let search = '';
  let offset = 0;
  let total = 0;
  let debounceTimer = null;
  let requestToken = 0;

  async function load(reset) {
    if (reset) {
      offset = 0;
      list.innerHTML = '<div class="empty-state">Loading…</div>';
    }
    const token = ++requestToken;
    try {
      const { items, total: newTotal } = await fetchSongs(search, offset, PAGE_SIZE);
      if (token !== requestToken) return;
      total = newTotal;
      if (reset) list.innerHTML = '';
      if (reset && !items.length) {
        list.innerHTML = '<div class="empty-state">No songs found</div>';
      }
      for (const song of items) list.appendChild(renderSongRow(song));
      offset += items.length;
      loadMoreBtn.classList.toggle('hidden', offset >= total || items.length === 0);
    } catch {
      if (reset) list.innerHTML = '<div class="empty-state">Couldn’t load songs</div>';
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      search = searchInput.value.trim();
      load(true);
    }, 300);
  });

  loadMoreBtn.addEventListener('click', () => load(false));

  load(true);

  return () => clearTimeout(debounceTimer);
}

registerRoute('/songs', renderSongs);
