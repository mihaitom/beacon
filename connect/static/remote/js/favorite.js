// favorite.js — the favourite toggle the song lists and the queue share
// in their action sheets, and the heart on Now Playing goes through.

import { sendCommand } from './api.js';
import { state } from './state.js';
import { t } from './i18n.js';

/** Sends what the phone wants rather than "toggle" (see the desktop's
 * set-favorite), and flips the song it was shown for once that landed, so
 * the next sheet opened on the same row reads right. */
export function setFavorite(song, favorite) {
  return sendCommand('set-favorite', { songId: song.id, favorite }).then(() => {
    song.starred = favorite;
  });
}

/** The sheet entry for `song`, or null where the server has no favourites. */
export function favoriteAction(song) {
  if (!state.snapshot.favorites_supported) return null;
  return {
    label: t(song.starred ? 'favorite.remove' : 'favorite.add'),
    icon: song.starred ? 'mdi-heart' : 'mdi-heart-outline',
    onSelect: () => setFavorite(song, !song.starred),
  };
}
