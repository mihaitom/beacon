// i18n.js — the remote's own translations, in the five languages the app
// has. The phone's language decides, the same way the app picks one for an
// account that never chose (src/renderer/src/i18n/index.ts's
// browserLocale): this is a different device, and often a different person.

import de from './locales/de.js';
import en from './locales/en.js';
import es from './locales/es.js';
import fr from './locales/fr.js';
import it from './locales/it.js';

const MESSAGES = { de, en, es, fr, it };

export const locale = MESSAGES[navigator.language?.slice(0, 2)] ? navigator.language.slice(0, 2) : 'en';

/** `{name}` placeholders are filled from `params`. A key missing in this
 * language falls back to English, then to the key itself. */
export function t(key, params = {}) {
  const message = MESSAGES[locale][key] ?? en[key] ?? key;
  return message.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
}

/** A count the way this language writes it: 1.234, 1,234, 1 234. */
export function n(value) {
  return new Intl.NumberFormat(locale).format(value);
}

/** The static markup's words: `data-i18n` sets an element's text,
 * `data-i18n-<attribute>` one of its attributes. */
export function translateDocument(root = document) {
  document.documentElement.lang = locale;
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const attribute of ['placeholder', 'title', 'aria-label']) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
