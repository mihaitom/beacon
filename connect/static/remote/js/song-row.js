// song-row.js — shared row renderer for song lists (Songs view, Playlist
// detail), with a "…" action sheet (Play, Play Next, Add to Queue, Start
// Song Radio).

import { fireCommand, sendCommand } from './api.js';
import { openActionSheet } from './sheet.js';
import { createArt } from './art.js';

export function renderSongRow(song, { onPlay } = {}) {
  const row = document.createElement('div');
  row.className = 'row';

  // Same placeholder the app falls back to (CoverArt.vue's own default):
  // a track whose server has no art for it, or whose URL fails to load,
  // otherwise leaves a bare grey square that reads as a broken row rather
  // than as "no cover".
  row.appendChild(createArt(song.cover_art_url, 'mdi-album'));

  const main = document.createElement('div');
  main.className = 'row-main';
  main.addEventListener('click', () => (onPlay ? onPlay() : fireCommand('play-song', { songId: song.id })));

  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = song.title;
  main.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.className = 'row-subtitle';
  subtitle.textContent = song.artist || '';
  main.appendChild(subtitle);

  row.appendChild(main);

  const actionBtn = document.createElement('button');
  actionBtn.className = 'row-action';
  actionBtn.innerHTML = '<i class="mdi mdi-dots-vertical"></i>';
  actionBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openActionSheet([
      { label: 'Play', icon: 'mdi-play', onSelect: () => sendCommand('play-song', { songId: song.id }) },
      {
        label: 'Play Next',
        icon: 'mdi-playlist-plus',
        onSelect: () => sendCommand('queue-next', { songId: song.id }),
      },
      {
        label: 'Add to Queue',
        icon: 'mdi-plus',
        onSelect: () => sendCommand('queue-add', { songId: song.id }),
      },
      {
        label: 'Start Song Radio',
        icon: 'mdi-antenna',
        onSelect: () => sendCommand('play-song-radio', { songId: song.id }),
      },
    ]);
  });
  row.appendChild(actionBtn);

  return row;
}
