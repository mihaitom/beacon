import { sendReportedCommand, fetchPlaylists, fetchPlaylist } from '../api.js';
import { renderSongRow } from '../song-row.js';
import { navigate, registerRoute } from '../router.js';
import { createArt } from '../art.js';
import { n, t } from '../i18n.js';

export function renderPlaylists(root) {
  root.innerHTML = `<h1 class="view-title">${t('playlists.title')}</h1><div class="list" id="playlist-list">${t('common.loading')}</div>`;
  const list = root.querySelector('#playlist-list');

  fetchPlaylists()
    .then(({ items }) => {
      list.innerHTML = '';
      if (!items.length) {
        list.innerHTML = `<div class="empty-state">${t('playlists.empty')}</div>`;
        return;
      }
      for (const playlist of items) {
        const row = document.createElement('div');
        row.className = 'row';
        row.appendChild(createArt(playlist.cover_art_url, 'mdi-playlist-music'));
        row.insertAdjacentHTML(
          'beforeend',
          `<div class="row-main"><div class="row-title">${escapeHtml(playlist.name)}</div>
          <div class="row-subtitle">${t('playlists.songCount', { count: n(playlist.song_count ?? 0) })}</div></div>`,
        );
        row.addEventListener('click', () => navigate(`/playlists/${encodeURIComponent(playlist.id)}`));
        list.appendChild(row);
      }
    })
    .catch(() => {
      list.innerHTML = `<div class="empty-state">${t('playlists.failed')}</div>`;
    });
}

export function renderPlaylistDetail(root, params) {
  root.innerHTML =
    `<a href="#/playlists" class="back-link"><i class="mdi mdi-chevron-left"></i>${t('playlists.title')}</a>` +
    `<div id="playlist-detail">${t('common.loading')}</div>`;
  const container = root.querySelector('#playlist-detail');

  fetchPlaylist(params.id)
    .then(({ playlist, songs }) => {
      container.innerHTML = '';
      const header = document.createElement('div');
      // The playlist's own name is this view's title, same treatment as
      // every other view's — the last .section-title in the remote, which
      // was a third heading size on top of the two the views used.
      header.innerHTML = `<h1 class="view-title">${escapeHtml(playlist.name)}</h1>`;
      const playAllBtn = document.createElement('button');
      playAllBtn.className = 'btn btn-primary play-all';
      const playAllIcon = document.createElement('i');
      playAllIcon.className = 'mdi mdi-play';
      playAllBtn.append(playAllIcon, t('action.playAll'));
      header.appendChild(playAllBtn);
      container.appendChild(header);

      // Acked only once playback has started, which with a speaker takes
      // seconds (COMMAND_TIMEOUT in routes/remote.py): until then the button
      // turns, and a second tap starts nothing.
      let pending = false;
      const play = (payload, busy) => {
        if (pending) return;
        pending = true;
        playAllBtn.disabled = true;
        playAllIcon.className = 'mdi mdi-loading mdi-spin';
        busy?.classList.add('row--busy');
        sendReportedCommand('play-playlist', { playlistId: playlist.id, ...payload })
          .catch(() => {})
          .finally(() => {
            pending = false;
            playAllBtn.disabled = false;
            playAllIcon.className = 'mdi mdi-play';
            busy?.classList.remove('row--busy');
          });
      };
      playAllBtn.addEventListener('click', () => play({}));

      const list = document.createElement('div');
      list.className = 'list';
      songs.forEach((song, index) => {
        const row = renderSongRow(song, { onPlay: () => play({ startIndex: index }, row) });
        list.appendChild(row);
      });
      container.appendChild(list);
    })
    .catch(() => {
      container.innerHTML = `<div class="empty-state">${t('playlist.failed')}</div>`;
    });
}

registerRoute('/playlists', renderPlaylists);
registerRoute('/playlists/:id', renderPlaylistDetail);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
