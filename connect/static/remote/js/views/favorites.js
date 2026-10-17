// favorites.js — the phone's favourites: songs and albums behind one
// toggle, the same shape as the mobile web UI's MobileFavoritesView.vue.
//
// Unlike library.js, both halves arrive in one answer: a favourites list is
// small enough not to page, so switching halves needs no second request.

import { fetchFavorites, fireCommand } from '../api.js';
import { registerRoute } from '../router.js';
import { renderAlbumRow } from '../album-row.js';
import { renderSongRow } from '../song-row.js';

const EMPTY = {
  songs: 'No favorite songs yet',
  albums: 'No favorite albums yet',
};

export function renderFavorites(root) {
  root.innerHTML = `
    <h1 class="view-title">Favorites</h1>
    <div class="segmented" id="favorites-toggle">
      <button type="button" class="active" data-view="songs">Songs</button>
      <button type="button" data-view="albums">Albums</button>
    </div>
    <div class="list" id="favorites-list"><div class="empty-state">Loading…</div></div>
  `;

  const toggle = root.querySelector('#favorites-toggle');
  const list = root.querySelector('#favorites-list');

  let view = 'songs';
  let favorites = null;

  function render() {
    if (!favorites) return;
    list.innerHTML = '';
    if (!favorites.supported) {
      list.innerHTML = '<div class="empty-state">This server has no favorites</div>';
      return;
    }
    const items = favorites[view];
    if (!items.length) {
      list.innerHTML = `<div class="empty-state">${EMPTY[view]}</div>`;
      return;
    }
    if (view === 'albums') {
      for (const album of items) list.appendChild(renderAlbumRow(album));
      return;
    }
    // The rest of the list plays on after the tapped song, as on the
    // desktop's favourites page. The id travels along so the desktop can
    // find the song even if a star changed since this list was fetched.
    items.forEach((song, index) => {
      list.appendChild(
        renderSongRow(song, {
          onPlay: () => fireCommand('play-favorites', { songId: song.id, startIndex: index }),
        }),
      );
    });
  }

  toggle.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button || button.dataset.view === view) return;
    view = button.dataset.view;
    for (const other of toggle.querySelectorAll('button')) {
      other.classList.toggle('active', other === button);
    }
    render();
  });

  fetchFavorites()
    .then((answer) => {
      favorites = answer;
      render();
    })
    .catch(() => {
      list.innerHTML = '<div class="empty-state">Couldn’t load favorites</div>';
    });
}

registerRoute('/favorites', renderFavorites);
