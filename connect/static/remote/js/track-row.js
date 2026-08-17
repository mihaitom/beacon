// track-row.js — shared row renderer for track lists (Tracks view, Playlist
// detail), with a "…" action sheet (Play, Play Next, Add to Queue, Start
// Track Radio).

import { sendCommand } from './api.js';
import { openActionSheet } from './sheet.js';
import { createArt } from './art.js';

export function renderTrackRow(track, { onPlay } = {}) {
  const row = document.createElement('div');
  row.className = 'row';

  row.appendChild(createArt(track.cover_art_url, null));

  const main = document.createElement('div');
  main.className = 'row-main';
  main.addEventListener('click', () => (onPlay ? onPlay() : sendCommand('play-track', { trackId: track.id })));

  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = track.title;
  main.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.className = 'row-subtitle';
  subtitle.textContent = track.artist || '';
  main.appendChild(subtitle);

  row.appendChild(main);

  const actionBtn = document.createElement('button');
  actionBtn.className = 'row-action';
  actionBtn.innerHTML = '<i class="mdi mdi-dots-vertical"></i>';
  actionBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openActionSheet([
      { label: 'Play', icon: 'mdi-play', onSelect: () => sendCommand('play-track', { trackId: track.id }) },
      {
        label: 'Play Next',
        icon: 'mdi-playlist-plus',
        onSelect: () => sendCommand('queue-next', { trackId: track.id }),
      },
      {
        label: 'Add to Queue',
        icon: 'mdi-plus',
        onSelect: () => sendCommand('queue-add', { trackId: track.id }),
      },
      {
        label: 'Start Track Radio',
        icon: 'mdi-antenna',
        onSelect: () => sendCommand('play-track-radio', { trackId: track.id }),
      },
    ]);
  });
  row.appendChild(actionBtn);

  return row;
}
