import { sendCommand, fetchPlaylists, fetchPlaylist } from '../api.js';
import { renderTrackRow } from '../track-row.js';
import { navigate, registerRoute } from '../router.js';

export function renderPlaylists(root) {
  root.innerHTML = '<h2 class="section-title">Playlists</h2><div class="list" id="playlist-list">Loading…</div>';
  const list = root.querySelector('#playlist-list');

  fetchPlaylists()
    .then(({ items }) => {
      list.innerHTML = '';
      if (!items.length) {
        list.innerHTML = '<div class="empty-state">No playlists</div>';
        return;
      }
      for (const playlist of items) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<div class="row-main"><div class="row-title">${escapeHtml(playlist.name)}</div>
          <div class="row-subtitle">${playlist.track_count ?? ''} tracks</div></div>`;
        row.addEventListener('click', () => navigate(`/playlists/${encodeURIComponent(playlist.id)}`));
        list.appendChild(row);
      }
    })
    .catch(() => {
      list.innerHTML = '<div class="empty-state">Couldn’t load playlists</div>';
    });
}

export function renderPlaylistDetail(root, params) {
  root.innerHTML =
    '<a href="#/playlists" class="back-link"><i class="mdi mdi-chevron-left"></i>Playlists</a><div id="playlist-detail">Loading…</div>';
  const container = root.querySelector('#playlist-detail');

  fetchPlaylist(params.id)
    .then(({ playlist, tracks }) => {
      container.innerHTML = '';
      const header = document.createElement('div');
      header.innerHTML = `<h2 class="section-title">${escapeHtml(playlist.name)}</h2>`;
      const playAllBtn = document.createElement('button');
      playAllBtn.className = 'btn btn-primary';
      playAllBtn.textContent = 'Play All';
      playAllBtn.style.marginBottom = '12px';
      playAllBtn.addEventListener('click', () => sendCommand('play-playlist', { playlistId: playlist.id }));
      header.appendChild(playAllBtn);
      container.appendChild(header);

      const list = document.createElement('div');
      list.className = 'list';
      tracks.forEach((track, index) => {
        list.appendChild(
          renderTrackRow(track, {
            onPlay: () => sendCommand('play-playlist', { playlistId: playlist.id, startIndex: index }),
          }),
        );
      });
      container.appendChild(list);
    })
    .catch(() => {
      container.innerHTML = '<div class="empty-state">Couldn’t load playlist</div>';
    });
}

registerRoute('/playlists', renderPlaylists);
registerRoute('/playlists/:id', renderPlaylistDetail);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
