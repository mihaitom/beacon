// artist.js — an artist's page: their most played songs, then their
// albums, newest first. The same page as the app's own on a phone
// (MobileArtistDetailView.vue), answered by the desktop out of its library.

import { fetchArtist, fireCommand } from '../api.js';
import { registerRoute } from '../router.js';
import { renderAlbumRow } from '../album-row.js';
import { renderSongRow } from '../song-row.js';
import { createArt } from '../art.js';
import { n, t } from '../i18n.js';

export function renderArtist(root, params) {
  // Back to wherever the artist was opened from - the library, a song's
  // actions, Now Playing - rather than to one fixed list.
  root.innerHTML =
    `<button type="button" class="back-link" id="artist-back"><i class="mdi mdi-chevron-left"></i>${t('common.back')}</button>` +
    `<div id="artist-detail"><div class="empty-state">${t('common.loading')}</div></div>`;
  root.querySelector('#artist-back').addEventListener('click', () => history.back());
  const container = root.querySelector('#artist-detail');

  fetchArtist(params.id)
    .then(({ artist, songs, albums }) => {
      if (!artist) {
        container.innerHTML = `<div class="empty-state">${t('artist.failed')}</div>`;
        return;
      }
      container.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'artist-header';
      header.appendChild(createArt(artist.cover_art_url, 'mdi-account-music', 'artist-header__art'));
      const text = document.createElement('div');
      text.className = 'artist-header__text';
      const name = document.createElement('h1');
      name.className = 'view-title';
      name.textContent = artist.name;
      const meta = document.createElement('div');
      meta.className = 'row-subtitle';
      const count = albums.length;
      meta.textContent = t(count === 1 ? 'artist.albumCount1' : 'artist.albumCountN', { count: n(count) });
      text.append(name, meta);
      header.appendChild(text);
      container.appendChild(header);

      const radio = document.createElement('button');
      radio.type = 'button';
      radio.className = 'btn btn-primary artist-radio';
      radio.innerHTML = `<i class="mdi mdi-radio-tower"></i> ${t('artist.radio')}`;
      radio.addEventListener('click', () => fireCommand('play-artist-radio', { artistId: artist.id }));
      container.appendChild(radio);

      if (songs.length) {
        container.insertAdjacentHTML('beforeend', `<h2 class="section-heading">${t('artist.mostPlayed')}</h2>`);
        const list = document.createElement('div');
        list.className = 'list';
        // The rest of them follow the tapped song, as on the app's page.
        songs.forEach((song, index) => {
          list.appendChild(
            renderSongRow(song, {
              onPlay: () =>
                fireCommand('play-artist-songs', { artistId: artist.id, songId: song.id, startIndex: index }),
            }),
          );
        });
        container.appendChild(list);
      }

      if (albums.length) {
        container.insertAdjacentHTML('beforeend', `<h2 class="section-heading">${t('artist.albums')}</h2>`);
        const list = document.createElement('div');
        list.className = 'list';
        for (const album of albums) list.appendChild(renderAlbumRow(album));
        container.appendChild(list);
      }
    })
    .catch(() => {
      container.innerHTML = `<div class="empty-state">${t('artist.failed')}</div>`;
    });
}

registerRoute('/artists/:id', renderArtist);
