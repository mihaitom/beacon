import { fetchRadioStations } from '../api.js';
import { navigate, registerRoute } from '../router.js';
import { renderRadioRow } from '../radio-row.js';
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
      for (const station of items) list.appendChild(renderRadioRow(station));
    })
    .catch(() => {
      list.innerHTML = `<div class="empty-state">${t('radio.failed')}</div>`;
    });
}

registerRoute('/radio', renderRadio);
// More held only Radio; an installed shell left on the old hash lands on
// the Radio tab instead of a blank page.
registerRoute('/more', () => navigate('/radio'));
