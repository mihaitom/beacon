// album-row.js — row renderer for the library view's albums half, the
// counterpart to song-row.js.
//
// Tapping the row plays the album, matching both song-row.js's own
// tap-is-play and the mobile web UI's MobileAlbumRow.vue. No action sheet:
// everything song-row.js offers in one ("Play Next", "Add to Queue", "Song
// Radio") is a per-song action, and none of them has an album-level command
// behind it on the desktop side.

import { fireCommand } from './api.js';
import { createArt } from './art.js';

export function renderAlbumRow(album) {
  const row = document.createElement('div');
  row.className = 'row';

  row.appendChild(createArt(album.cover_art_url, 'mdi-album'));

  const main = document.createElement('div');
  main.className = 'row-main';
  main.addEventListener('click', () => fireCommand('play-album', { albumId: album.id }));

  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = album.name;
  main.appendChild(title);

  // Artist first, since that is what tells two same-named albums apart; the
  // year only when the server actually reports one.
  const subtitle = document.createElement('div');
  subtitle.className = 'row-subtitle';
  subtitle.textContent = [album.artist, album.year].filter(Boolean).join(' · ');
  main.appendChild(subtitle);

  row.appendChild(main);
  return row;
}
