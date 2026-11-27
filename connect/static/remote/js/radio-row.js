// radio-row.js — a station's row, in the Radio tab and in the search's
// results. A tap plays it; editing a station is the app's business.

import { fireCommand } from './api.js';
import { createArt } from './art.js';

export function renderRadioRow(station) {
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(createArt(station.favicon_url, 'mdi-radio'));

  const main = document.createElement('div');
  main.className = 'row-main';
  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = station.name;
  main.appendChild(title);
  row.appendChild(main);

  row.addEventListener('click', () => fireCommand('play-radio-station', { stationId: station.id }));
  return row;
}
