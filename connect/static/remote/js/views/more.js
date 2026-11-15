// more.js — the fifth tab: the pages worth reaching that are not one of
// the four tabs for getting to music. Radio lives here now, as it does
// behind the app's own More tab (MobileMoreView.vue); Stats, Settings, the
// pages of your own apps and the party stay desktop-only.

import { registerRoute } from '../router.js';
import { t } from '../i18n.js';

export function renderMore(root) {
  root.innerHTML = `
    <h1 class="view-title">${t('tab.more')}</h1>
    <div class="more-list">
      <a class="more-item" href="#/radio">
        <i class="mdi mdi-radio more-item__icon"></i>
        <span class="more-item__label">${t('nav.radio')}</span>
        <i class="mdi mdi-chevron-right more-item__chevron"></i>
      </a>
    </div>
  `;
}

registerRoute('/more', renderMore);
