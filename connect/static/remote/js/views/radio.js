import { fireCommand, fetchRadioStations } from '../api.js';
import { registerRoute } from '../router.js';
import { createArt } from '../art.js';
import { t } from '../i18n.js';

export function renderRadio(root) {
  root.innerHTML = `<h1 class="view-title">${t('radio.title')}</h1><div class="list" id="radio-list">${t('common.loading')}</div>`;
  const list = root.querySelector('#radio-list');

  fetchRadioStations()
    .then(({ items }) => {
      list.innerHTML = '';
      if (!items.length) {
        list.innerHTML = `<div class="empty-state">${t('radio.empty')}</div>`;
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

        row.addEventListener('click', () => fireCommand('play-radio-station', { stationId: station.id }));
        list.appendChild(row);
      }
    })
    .catch(() => {
      list.innerHTML = `<div class="empty-state">${t('radio.failed')}</div>`;
    });
}

registerRoute('/radio', renderRadio);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
