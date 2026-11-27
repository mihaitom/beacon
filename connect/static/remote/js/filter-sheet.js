// filter-sheet.js — the library's filter menu (the app's
// LibraryFilterMenu.vue) as a bottom sheet: one entry per field with what
// is picked under its name, each opening the options the library holds
// there and how many items each has. Several options of one field mean any
// of them; several fields mean all of them. Every pick applies at once.

import { lockScroll } from './scroll-lock.js';
import { n, t } from './i18n.js';

/**
 * `fields` is the answer's filter_fields; `filters` what is picked,
 * `{ field: [option, ...] }`. `onChange(filters)` gets the new picks.
 */
export function openFilterSheet({ fields, filters, onChange }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet filter-sheet';
  sheet.dataset.scrolls = '';
  const unlockScroll = lockScroll();
  let picked = structuredClone(filters);
  let openField = null;

  function close() {
    unlockScroll();
    backdrop.remove();
    sheet.remove();
  }

  function labelOf(field, option) {
    return field.options.find((entry) => entry.option === option)?.label ?? option;
  }

  function toggle(field, option) {
    const current = picked[field.field] ?? [];
    const next = current.includes(option)
      ? current.filter((existing) => existing !== option)
      : [...current, option];
    picked = { ...picked };
    if (next.length) picked[field.field] = next;
    else delete picked[field.field];
    onChange(picked);
    render();
  }

  function button(className, html, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.innerHTML = html;
    el.addEventListener('click', onClick);
    return el;
  }

  function renderFields() {
    const title = document.createElement('div');
    title.className = 'sheet-title';
    title.textContent = t('library.filter');
    sheet.appendChild(title);
    for (const field of fields) {
      const chosen = picked[field.field] ?? [];
      const entry = button('filter-sheet__field', '', () => {
        openField = field;
        render();
      });
      entry.classList.toggle('filter-sheet__field--on', chosen.length > 0);
      const text = document.createElement('span');
      text.className = 'filter-sheet__text';
      const name = document.createElement('span');
      name.textContent = field.label;
      text.appendChild(name);
      // What is picked, under the field's name - so the menu itself says
      // what the list is filtered by.
      if (chosen.length) {
        const summary = document.createElement('span');
        summary.className = 'filter-sheet__summary';
        summary.textContent = chosen.map((option) => labelOf(field, option)).join(', ');
        text.appendChild(summary);
      }
      entry.appendChild(text);
      entry.insertAdjacentHTML('beforeend', '<i class="mdi mdi-chevron-right filter-sheet__chevron"></i>');
      sheet.appendChild(entry);
    }
    const reset = button(
      'filter-sheet__reset',
      `<i class="mdi mdi-filter-off-outline sheet-icon"></i>${t('library.resetFilters')}`,
      () => {
        picked = {};
        onChange(picked);
        render();
      },
    );
    reset.disabled = !Object.keys(picked).length;
    sheet.appendChild(reset);
  }

  function renderOptions(field) {
    const back = button(
      'sheet-title filter-sheet__back',
      `<i class="mdi mdi-chevron-left"></i>`,
      () => {
        openField = null;
        render();
      },
    );
    back.append(field.label);
    back.setAttribute('aria-label', `${t('common.back')}: ${field.label}`);
    sheet.appendChild(back);
    const chosen = picked[field.field] ?? [];
    for (const { option, label, count } of field.options) {
      const on = chosen.includes(option);
      const entry = button('filter-sheet__option', '', () => toggle(field, option));
      entry.setAttribute('role', 'checkbox');
      entry.setAttribute('aria-checked', String(on));
      entry.innerHTML = `<i class="mdi ${on ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline'} sheet-icon"></i>`;
      const name = document.createElement('span');
      name.className = 'filter-sheet__text';
      name.textContent = label;
      const amount = document.createElement('span');
      amount.className = 'filter-sheet__count';
      amount.textContent = n(count);
      entry.append(name, amount);
      sheet.appendChild(entry);
    }
  }

  function render() {
    sheet.innerHTML = '';
    if (openField) renderOptions(openField);
    else renderFields();
  }

  backdrop.addEventListener('click', close);
  render();
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  return { close };
}
