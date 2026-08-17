import { sendCommand, fetchRadioStations } from '../api.js';
import { registerRoute } from '../router.js';
import { createArt } from '../art.js';

export function renderRadio(root) {
  root.innerHTML = '<h2 class="section-title">Internet Radio</h2><div class="list" id="radio-list">Loading…</div>';
  const list = root.querySelector('#radio-list');

  fetchRadioStations()
    .then(({ items }) => {
      list.innerHTML = '';
      if (!items.length) {
        list.innerHTML = '<div class="empty-state">No radio stations. Add some in Beacon’s library.</div>';
        return;
      }
      for (const station of items) {
        const row = document.createElement('div');
        row.className = 'row';

        row.appendChild(createArt(station.favicon_url, 'mdi-radio'));

        const main = document.createElement('div');
        main.className = 'row-main';
        main.innerHTML = `<div class="row-title">${escapeHtml(station.name)}</div>`;
        row.appendChild(main);

        row.addEventListener('click', () => sendCommand('play-radio-station', { stationId: station.id }));
        list.appendChild(row);
      }
    })
    .catch(() => {
      list.innerHTML = '<div class="empty-state">Couldn’t load radio stations</div>';
    });
}

registerRoute('/radio', renderRadio);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
