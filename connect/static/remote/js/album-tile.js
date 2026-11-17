// album-tile.js — the square album card Home's shelves and grids use.
//
// Two targets, like MobileAlbumTile.vue: the cover carries a play mark and
// plays, the name opens the album. Home is for starting something, so the
// play is the bigger target here.

import { createArt } from './art.js';
import { navigate } from './router.js';
import { t } from './i18n.js';

export function renderAlbumTile(album, { shelf = false, onPlay } = {}) {
  const tile = document.createElement('div');
  tile.className = shelf ? 'album-tile album-tile--shelf' : 'album-tile';

  const cover = document.createElement('button');
  cover.type = 'button';
  cover.className = 'album-tile__cover';
  cover.title = `${t('library.play')}: ${album.name}`;
  cover.setAttribute('aria-label', cover.title);
  cover.appendChild(createArt(album.cover_art_url, 'mdi-album', 'album-tile__art'));
  const play = document.createElement('i');
  play.className = 'mdi mdi-play album-tile__play';
  cover.appendChild(play);
  cover.disabled = !onPlay;
  if (onPlay) {
    cover.addEventListener('click', () => onPlay(album));
  }
  tile.appendChild(cover);

  const text = document.createElement('button');
  text.type = 'button';
  text.className = 'album-tile__text';
  const title = document.createElement('span');
  title.className = 'album-tile__name';
  title.textContent = album.name;
  text.appendChild(title);
  const subtitle = document.createElement('span');
  subtitle.className = 'album-tile__artist';
  subtitle.textContent = album.artist || '';
  text.appendChild(subtitle);
  text.addEventListener('click', () => navigate(`/albums/${encodeURIComponent(album.id)}`));
  tile.appendChild(text);

  return tile;
}
