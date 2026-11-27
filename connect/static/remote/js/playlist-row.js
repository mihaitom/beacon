// playlist-row.js — the row a playlist gets in the Playlists tab and in
// the search's results.

import { sendReportedCommand } from './api.js';
import { navigate } from './router.js';
import { createArt } from './art.js';
import { n, t } from './i18n.js';

function formatDuration(seconds) {
  if (!seconds) return '';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) return t('playlists.durationHours', { hours, minutes });
  return t('playlists.durationMinutes', { minutes });
}

function playlistMeta(playlist, { showOwner = false } = {}) {
  const parts = [
    t('playlists.songCount', { count: n(playlist.song_count ?? 0) }),
    formatDuration(playlist.duration),
    playlist.smart ? t('playlists.smart') : '',
  ].filter(Boolean);
  if (showOwner && playlist.owner) {
    parts.push(t('playlists.byOwner', { owner: playlist.owner }));
  }
  return parts.join(' · ');
}

export function renderPlaylistRow(playlist, { showOwner = false } = {}) {
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(createArt(playlist.cover_art_url, 'mdi-playlist-music'));

  const main = document.createElement('div');
  main.className = 'row-main';
  main.addEventListener('click', () => navigate(`/playlists/${encodeURIComponent(playlist.id)}`));
  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = playlist.name;
  const subtitle = document.createElement('div');
  subtitle.className = 'row-subtitle';
  subtitle.textContent = playlistMeta(playlist, { showOwner });
  main.append(title, subtitle);
  row.appendChild(main);

  // A row that stands for a collection leads to it; the button plays it
  // (see MobilePlaylistRow.vue's own split).
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'row-action row-play';
  play.title = t('library.play');
  play.setAttribute('aria-label', t('library.play'));
  play.innerHTML = '<i class="mdi mdi-play-circle"></i>';
  play.addEventListener('click', (event) => {
    event.stopPropagation();
    sendReportedCommand('play-playlist', { playlistId: playlist.id }).catch(() => {});
  });
  row.appendChild(play);
  return row;
}
