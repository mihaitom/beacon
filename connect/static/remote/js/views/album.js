// album.js — an album's page: its tracks in album order, the artist's
// page from the artist line, and a play button for the whole thing. The
// same page as the app's own on a phone (MobileAlbumDetailView.vue),
// answered by the desktop out of its library.

import { fetchAlbum, sendCommand } from '../api.js';
import { registerRoute, navigate } from '../router.js';
import { renderSongRow } from '../song-row.js';
import { createArt } from '../art.js';
import { state } from '../state.js';
import { n, t } from '../i18n.js';

export function renderAlbum(root, params) {
  root.innerHTML =
    `<button type="button" class="back-link" id="album-back"><i class="mdi mdi-chevron-left"></i>${t('common.back')}</button>` +
    `<div id="album-detail"><div class="empty-state">${t('common.loading')}</div></div>`;
  root.querySelector('#album-back').addEventListener('click', () => history.back());
  const container = root.querySelector('#album-detail');

  fetchAlbum(params.id)
    .then(({ album, songs }) => {
      if (!album) {
        container.innerHTML = `<div class="empty-state">${t('album.failed')}</div>`;
        return;
      }
      container.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'artist-header';
      header.appendChild(createArt(album.cover_art_url, 'mdi-album', 'artist-header__art'));

      const text = document.createElement('div');
      text.className = 'artist-header__text';
      const name = document.createElement('h1');
      name.className = 'view-title';
      name.textContent = album.name;
      // Like the app's own page, the artist line leads to their page where
      // the server gave the album an artist id.
      const artistLine = document.createElement(album.artist_id ? 'button' : 'div');
      if (album.artist_id) artistLine.type = 'button';
      artistLine.className = 'album-artist';
      artistLine.textContent = album.artist || '';
      if (album.artist_id) {
        artistLine.addEventListener('click', () =>
          navigate(`/artists/${encodeURIComponent(album.artist_id)}`),
        );
      }
      const meta = document.createElement('div');
      meta.className = 'row-subtitle';
      const count = t('library.songCount', { count: n(songs.length) });
      meta.textContent = album.year ? `${album.year} · ${count}` : count;
      text.append(name, artistLine, meta);
      header.appendChild(text);

      if (state.snapshot.favorites_supported) {
        header.appendChild(favoriteButton(album));
      }

      container.appendChild(header);

      const playAll = document.createElement('button');
      playAll.type = 'button';
      playAll.className = 'btn btn-primary play-all album-play-all';
      playAll.innerHTML = `<i class="mdi mdi-play"></i> ${t('action.playAll')}`;
      playAll.disabled = !songs.length;
      playAll.addEventListener('click', () =>
        sendCommand('play-album', { albumId: album.id, startIndex: 0 }).catch(reportFailure),
      );
      const actions = document.createElement('div');
      actions.className = 'album-actions';
      actions.appendChild(playAll);
      container.appendChild(actions);

      const list = document.createElement('div');
      list.className = 'list';
      songs.forEach((song, index) => {
        list.appendChild(
          renderSongRow(song, {
            onPlay: () =>
              sendCommand('play-album', {
                albumId: album.id,
                startIndex: index,
              }).catch(reportFailure),
          }),
        );
      });
      container.appendChild(list);
    })
    .catch(() => {
      container.innerHTML = `<div class="empty-state">${t('album.failed')}</div>`;
    });

  function reportFailure() {
    window.dispatchEvent(new CustomEvent('beacon-remote-command-failed'));
  }

  function favoriteButton(album) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'header-favorite';
    const paint = () => {
      const on = Boolean(album.starred);
      button.innerHTML = `<i class="mdi ${on ? 'mdi-heart' : 'mdi-heart-outline'}"></i>`;
      button.classList.toggle('active', on);
      button.title = t(on ? 'favorite.remove' : 'favorite.add');
      button.setAttribute('aria-label', button.title);
    };
    paint();
    button.addEventListener('click', () => {
      sendCommand('set-favorite-album', { albumId: album.id, favorite: !album.starred })
        .then(() => {
          album.starred = !album.starred;
          paint();
        })
        .catch(reportFailure);
    });
    return button;
  }
}

registerRoute('/albums/:id', renderAlbum);
