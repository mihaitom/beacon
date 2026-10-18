// artist-row.js — row renderer for artists (the library's artists half, the
// favourites' artists). A row that stands for a collection opens it, the
// same split as the app's MobileArtistRow.vue; there is no one order to
// play an artist in, and the page it opens has the artist radio for that.

import { navigate } from './router.js';
import { createArt } from './art.js';
import { n, t } from './i18n.js';

export function renderArtistRow(artist) {
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(createArt(artist.cover_art_url, 'mdi-account-music'));

  const main = document.createElement('div');
  main.className = 'row-main';

  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = artist.name;
  main.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.className = 'row-subtitle';
  const count = artist.album_count ?? 0;
  subtitle.textContent = t(count === 1 ? 'artist.albumCount1' : 'artist.albumCountN', { count: n(count) });
  main.appendChild(subtitle);

  row.appendChild(main);
  row.addEventListener('click', () => navigate(`/artists/${encodeURIComponent(artist.id)}`));
  return row;
}
