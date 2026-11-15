// more.js — the fifth tab: the pages worth reaching that are not one of
// the four tabs for getting to music. Radio and the party live here now,
// as they do behind the app's own More tab (MobileMoreView.vue); Stats,
// Settings and the pages of your own apps stay desktop-only.

import { registerRoute } from '../router.js';
import { state, subscribe } from '../state.js';
import { n, t } from '../i18n.js';

export function renderMore(root) {
  root.innerHTML = `
    <h1 class="view-title">${t('tab.more')}</h1>
    <div class="more-list">
      <a class="more-item" href="#/radio">
        <i class="mdi mdi-radio more-item__icon"></i>
        <span class="more-item__label">${t('nav.radio')}</span>
        <i class="mdi mdi-chevron-right more-item__chevron"></i>
      </a>
      <a class="more-item" href="#/party">
        <i class="mdi mdi-party-popper more-item__icon"></i>
        <span class="more-item__label">${t('party.title')}</span>
        <span class="more-item__badge hidden" id="more-party-badge"></span>
        <i class="mdi mdi-chevron-right more-item__chevron"></i>
      </a>
    </div>
  `;
  const badge = root.querySelector('#more-party-badge');

  function render(s) {
    const party = s.snapshot.party;
    const guests = party?.running ? party.guests ?? 0 : 0;
    badge.classList.toggle('hidden', guests === 0);
    badge.textContent = n(guests);
  }

  const unsubscribe = subscribe(render);
  render(state);
  return unsubscribe;
}

registerRoute('/more', renderMore);
