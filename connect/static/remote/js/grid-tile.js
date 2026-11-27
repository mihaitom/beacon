// grid-tile.js — a library card in the grid layout, for a song, an album
// or an artist: the app's MobileGridTile.vue, which itself follows the
// desktop's cards. A 4px cover with the heart on it, the name over a
// quieter second line.
//
// Where a tap leads: an album or artist card opens its page anywhere on
// it. A song has no page, so its cover plays it and its title leads to its
// album, the desktop card's choice too.

import { sendReportedCommand } from './api.js';
import { navigate } from './router.js';
import { createArt } from './art.js';
import { state } from './state.js';
import { n, t } from './i18n.js';

const FAVORITE_COMMAND = {
  song: (item, favorite) => ['set-favorite', { songId: item.id, favorite }],
  album: (item, favorite) => ['set-favorite-album', { albumId: item.id, favorite }],
  artist: (item, favorite) => ['set-favorite-artist', { artistId: item.id, favorite }],
};

const FALLBACK_ICON = { song: 'mdi-music-note', album: 'mdi-album', artist: 'mdi-account-music' };

function heartButton(kind, item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'grid-tile__star';
  const sync = () => {
    button.classList.toggle('grid-tile__star--on', Boolean(item.starred));
    button.innerHTML = `<i class="mdi ${item.starred ? 'mdi-heart' : 'mdi-heart-outline'}"></i>`;
    const label = t(item.starred ? 'favorite.remove' : 'favorite.add');
    button.title = label;
    button.setAttribute('aria-label', label);
  };
  sync();
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    const [type, payload] = FAVORITE_COMMAND[kind](item, !item.starred);
    sendReportedCommand(type, payload)
      .then(() => {
        item.starred = !item.starred;
        sync();
      })
      .catch(() => {})
      .finally(() => {
        button.disabled = false;
      });
  });
  return button;
}

/** `onPlay` plays a song card; album and artist cards open their page. */
export function renderGridTile(kind, item, { onPlay } = {}) {
  const tile = document.createElement('div');
  tile.className = 'grid-tile';
  const title = kind === 'song' ? item.title : item.name;

  const cover = document.createElement(kind === 'song' ? 'button' : 'div');
  cover.className = 'grid-tile__cover';
  cover.appendChild(createArt(item.cover_art_url, FALLBACK_ICON[kind], 'grid-tile__art'));
  if (kind === 'song') {
    cover.type = 'button';
    cover.setAttribute('aria-label', `${t('library.play')}: ${title}`);
    const play = document.createElement('i');
    play.className = 'mdi mdi-play-circle grid-tile__play';
    play.setAttribute('aria-hidden', 'true');
    cover.appendChild(play);
    cover.addEventListener('click', () => onPlay?.());
  }
  if (state.snapshot.favorites_supported) cover.appendChild(heartButton(kind, item));
  tile.appendChild(cover);

  const name = document.createElement(kind === 'song' && item.album_id ? 'button' : 'span');
  name.className = 'grid-tile__title';
  name.textContent = title;
  if (kind === 'song' && item.album_id) {
    name.type = 'button';
    name.addEventListener('click', () => navigate(`/albums/${encodeURIComponent(item.album_id)}`));
  }
  tile.appendChild(name);

  const meta = document.createElement('span');
  meta.className = 'grid-tile__meta';
  if (kind === 'artist') {
    meta.innerHTML = `<span><i class="mdi mdi-album"></i>${n(item.album_count ?? 0)}</span>`;
    // Only once the catalogue it is counted from has arrived: a 0 there
    // would be wrong rather than merely absent.
    if (item.song_count != null) {
      meta.insertAdjacentHTML(
        'beforeend',
        `<span><i class="mdi mdi-music-note"></i>${n(item.song_count)}</span>`,
      );
    }
  } else {
    meta.textContent = item.artist || '';
  }
  tile.appendChild(meta);

  if (kind !== 'song') {
    const path = kind === 'album' ? 'albums' : 'artists';
    tile.classList.add('grid-tile--link');
    tile.addEventListener('click', () => navigate(`/${path}/${encodeURIComponent(item.id)}`));
  }
  return tile;
}
