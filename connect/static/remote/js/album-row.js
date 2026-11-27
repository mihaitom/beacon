// album-row.js — row renderer for the library view's albums half, the
// counterpart to song-row.js.
//
// Tapping the row opens the album, the same split MobileAlbumRow.vue makes:
// a row that stands for a collection leads to it, and its own play button
// is what plays it. No action sheet: everything song-row.js offers in one
// ("Play Next", "Add to Queue", "Song Radio") is a per-song action, and
// none of them has an album-level command behind it on the desktop side.

import { fireCommand } from './api.js';
import { navigate } from './router.js';
import { createArt } from './art.js';
import { t } from './i18n.js';
import { fillSplitLine } from './split-line.js';

/** `detail` is what the library is sorted by; it takes the year's place. */
export function renderAlbumRow(album, { detail } = {}) {
  const row = document.createElement('div');
  row.className = 'row';

  row.appendChild(createArt(album.cover_art_url, 'mdi-album'));

  const main = document.createElement('div');
  main.className = 'row-main';
  main.addEventListener('click', () => navigate(`/albums/${encodeURIComponent(album.id)}`));

  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = album.name;
  main.appendChild(title);

  // Artist first, since that is what tells two same-named albums apart; the
  // year only when the server reports one. Sorted by something, the line
  // shows that at its end instead of the year.
  const subtitle = document.createElement('div');
  subtitle.className = 'row-subtitle';
  if (detail) fillSplitLine(subtitle, album.artist || '', detail);
  else subtitle.textContent = [album.artist, album.year].filter(Boolean).join(' · ');
  main.appendChild(subtitle);

  row.appendChild(main);
  row.appendChild(playButton(album));
  return row;
}

/** The album's own play button — the row's tap goes to the album page. */
export function playButton(album) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-action row-play';
  button.title = t('library.play');
  button.setAttribute('aria-label', t('library.play'));
  button.innerHTML = '<i class="mdi mdi-play-circle"></i>';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    fireCommand('play-album', { albumId: album.id });
  });
  return button;
}
