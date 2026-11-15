// lights.js — the Philips Hue setup behind Now Playing's lightbulb. The
// full dialog in the app also previews the lights and sets the lead; this
// is the part that makes sense from a phone: pair the bridge, pick the
// area, style and colour, and set the brightness.
//
// The dialog shell is the equalizer's (a centred card with a clear Done
// button), so both of Now Playing's sheets behave the same way.

import {
  fetchLightBridges,
  fetchLights,
  forgetLights,
  pairLights,
  updateLights,
} from './api.js';
import { paintRange } from './range.js';
import { t } from './i18n.js';

// The app's LightsDialog.vue cards, icon for icon.
const STYLES = [
  { value: 'pulse', icon: 'mdi-pulse' },
  { value: 'calm', icon: 'mdi-weather-night' },
  { value: 'party', icon: 'mdi-party-popper' },
  { value: 'chase', icon: 'mdi-chevron-triple-right' },
];
const COLOUR_MODES = ['theme', 'palette', 'rotate', 'fixed'];
const WHEEL = 'conic-gradient(#ff3b3b, #ffd23b, #3bff6b, #3bd8ff, #3b5bff, #d43bff, #ff3b3b)';
const MIN_BRIGHTNESS = 20;
// The app's own wait: a drag or held arrow key settles into one save.
const SAVE_DELAY_MS = 400;

function hueToHex(hue) {
  const h = ((Number(hue) % 360) + 360) % 360;
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [1, x, 0];
  else if (h < 120) [r, g, b] = [x, 1, 0];
  else if (h < 180) [r, g, b] = [0, 1, x];
  else if (h < 240) [r, g, b] = [0, x, 1];
  else if (h < 300) [r, g, b] = [x, 0, 1];
  else [r, g, b] = [1, 0, x];
  return (
    '#' +
    [r, g, b].map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')
  );
}

function hueOf(hex) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!match) return 0;
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return Math.round(((hue * 60) % 360 + 360) % 360);
}

export function openLights({ onChange } = {}) {
  document.querySelectorAll('.eq-overlay').forEach((element) => element.remove());

  const overlay = document.createElement('div');
  overlay.className = 'eq-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'eq-dialog';
  dialog.innerHTML = `
    <div class="eq-dialog__head">
      <div class="eq-dialog__heading">
        <div class="eq-dialog__title">${t('lights.title')}</div>
      </div>
      <button type="button" class="eq-dialog__close" aria-label="${t('common.close')}">
        <i class="mdi mdi-close"></i>
      </button>
    </div>
    <div class="eq-dialog__body"><div class="empty-state">${t('common.loading')}</div></div>
    <div class="eq-dialog__footer">
      <button type="button" class="lights-forget hidden">${t('lights.forget')}</button>
      <button type="button" class="btn btn-primary lights-done">${t('common.done')}</button>
    </div>
  `;
  overlay.appendChild(dialog);

  const body = dialog.querySelector('.eq-dialog__body');
  const forgetButton = dialog.querySelector('.lights-forget');
  const doneButton = dialog.querySelector('.lights-done');
  const closeButton = dialog.querySelector('.eq-dialog__close');

  let state = null;
  let error = null;
  let pairing = false;
  let searching = false;
  let saving = false;
  let host = '';
  let searchedHosts = [];
  let brightnessTimer = null;
  let hueTimer = null;

  function close() {
    clearTimeout(brightnessTimer);
    clearTimeout(hueTimer);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }

  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  closeButton.addEventListener('click', close);
  doneButton.addEventListener('click', close);
  forgetButton.addEventListener('click', () => void forget());
  document.addEventListener('keydown', onKey);

  function setState(next) {
    state = next;
    if (state?.found?.length && !host) host = state.found[0].host;
    onChange?.(state);
    render();
  }

  function load() {
    body.innerHTML = `<div class="empty-state">${t('common.loading')}</div>`;
    fetchLights()
      .then((answer) => {
        if (!answer) {
          error = t('lights.loadFailed');
          render();
          return;
        }
        error = null;
        setState(answer);
      })
      .catch(() => {
        error = t('lights.loadFailed');
        render();
      });
  }

  /** Optimistic, then connect's answer replaces it. A failure reloads the
   * bridge's own state rather than leaving the switch somewhere it is not. */
  function save(update) {
    if (!state || saving) return;
    state = { ...state, ...update };
    error = null;
    onChange?.(state);
    render();
    updateLights(update)
      .then((answer) => {
        if (!answer) throw new Error('not saved');
        setState(answer);
      })
      .catch(() => {
        error = t('lights.saveFailed');
        load();
      });
  }

  async function search() {
    if (searching) return;
    searching = true;
    error = null;
    render();
    try {
      const answer = await fetchLightBridges();
      searchedHosts = answer?.bridges?.map((bridge) => bridge.host) ?? [];
      if (!host && searchedHosts.length) host = searchedHosts[0];
    } catch {
      error = t('lights.searchFailed');
    } finally {
      searching = false;
      render();
    }
  }

  async function pair() {
    if (!host || pairing) return;
    pairing = true;
    error = null;
    render();
    try {
      await pairLights(host);
      await load();
    } catch {
      error = t('lights.pairFailed');
    } finally {
      pairing = false;
      render();
    }
  }

  async function forget() {
    if (!confirm(t('lights.confirmForget'))) return;
    saving = true;
    error = null;
    render();
    try {
      await forgetLights();
      state = null;
      onChange?.(null);
      await load();
    } catch {
      error = t('lights.saveFailed');
    } finally {
      saving = false;
      render();
    }
  }

  function sectionLabel(text) {
    const label = document.createElement('h3');
    label.className = 'lights-label';
    label.textContent = text;
    return label;
  }

  function section(title, ...children) {
    const group = document.createElement('section');
    group.className = 'lights-group';
    group.appendChild(sectionLabel(title));
    group.append(...children);
    return group;
  }

  function hint(text) {
    const element = document.createElement('p');
    element.className = 'lights-hint';
    element.textContent = text;
    return element;
  }

  /** Four cards in a row, each a mark over its name - the app's styles
   * and colour modes. `mark` builds what sits on top. */
  function cards(values, active, onPick, label, mark) {
    const row = document.createElement('div');
    row.className = 'lights-cards';
    row.setAttribute('role', 'radiogroup');
    for (const value of values) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `lights-card${value === active ? ' active' : ''}`;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(value === active));
      button.disabled = saving;
      const name = document.createElement('span');
      name.textContent = label(value);
      button.append(mark(value), name);
      button.addEventListener('click', () => onPick(value));
      row.appendChild(button);
    }
    return row;
  }

  function icon(name) {
    const element = document.createElement('i');
    element.className = `mdi ${name}`;
    return element;
  }

  /** What each colour mode would give right now, as the app's chips do. */
  function chip(mode) {
    const element = document.createElement('span');
    element.className = 'lights-chip';
    const picture = state.picture;
    let background;
    if (mode === 'theme') {
      background =
        state.theme_follows_picture && picture?.accent ? picture.accent : state.theme_colour;
    } else if (mode === 'fixed') {
      background = state.fixed_colour;
    } else if (mode === 'rotate') {
      background = WHEEL;
    } else {
      const colours = picture?.colours?.length ? picture.colours : [state.theme_colour];
      const share = 100 / colours.length;
      const stops = colours.map((c, i) => `${c} ${i * share}% ${(i + 1) * share}%`);
      background = `conic-gradient(${stops.join(', ')})`;
    }
    if (background) element.style.background = background;
    return element;
  }

  function switchRow(checked, onChange) {
    const label = document.createElement('label');
    label.className = 'eq-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.disabled = saving;
    input.addEventListener('change', () => onChange(input.checked));
    const track = document.createElement('span');
    track.className = 'eq-switch__track';
    const thumb = document.createElement('span');
    thumb.className = 'eq-switch__thumb';
    track.appendChild(thumb);
    const text = document.createElement('span');
    text.className = 'eq-switch__label';
    text.textContent = t('lights.enabled');
    label.append(input, track, text);
    return label;
  }

  function render() {
    body.innerHTML = '';
    forgetButton.classList.toggle('hidden', !state?.paired);
    forgetButton.disabled = saving;
    // Before pairing, Pair is the one thing to do here; Done steps back.
    const pairingStep = Boolean(state && !state.paired);
    doneButton.classList.toggle('btn-primary', !pairingStep);
    doneButton.classList.toggle('btn-secondary', pairingStep);

    if (error) {
      const message = document.createElement('p');
      message.className = 'lights-error';
      message.textContent = error;
      body.appendChild(message);
    }

    if (!state) {
      if (!error) {
        const loading = document.createElement('div');
        loading.className = 'empty-state';
        loading.textContent = t('common.loading');
        body.appendChild(loading);
      }
      return;
    }

    if (!state.paired) {
      body.appendChild(hint(t('lights.pairIntro')));
      const row = document.createElement('div');
      row.className = 'lights-pair-row';
      const input = document.createElement('input');
      input.className = 'lights-input';
      input.type = 'text';
      input.inputMode = 'url';
      input.placeholder = t('lights.bridge');
      input.value = host;
      input.setAttribute('list', 'lights-bridges');
      input.disabled = pairing;
      input.addEventListener('input', () => (host = input.value.trim()));
      const datalist = document.createElement('datalist');
      datalist.id = 'lights-bridges';
      for (const found of new Set([...(state.found ?? []).map((b) => b.host), ...searchedHosts])) {
        const option = document.createElement('option');
        option.value = found;
        datalist.appendChild(option);
      }
      row.append(input, datalist);
      const searchButton = document.createElement('button');
      searchButton.type = 'button';
      searchButton.className = 'btn btn-secondary lights-search';
      searchButton.textContent = t('lights.search');
      searchButton.disabled = searching || pairing;
      searchButton.addEventListener('click', () => void search());
      row.appendChild(searchButton);
      body.appendChild(row);
      body.appendChild(hint(pairing ? t('lights.pressButton') : t('lights.pairHint')));
      const pairButton = document.createElement('button');
      pairButton.type = 'button';
      pairButton.className = 'btn btn-primary lights-pair';
      pairButton.textContent = t('lights.pair');
      pairButton.disabled = !host || pairing;
      pairButton.addEventListener('click', () => void pair());
      body.appendChild(pairButton);
      return;
    }

    body.appendChild(switchRow(state.enabled, (enabled) => save({ enabled })));

    // One line on how the bridge is doing, a dot in front: amber while the
    // lights play along, red where something stands in their way.
    const problem =
      state.reachable === false
        ? t('lights.unreachable', { host: state.bridge?.host ?? '' })
        : state.start_error && state.enabled
          ? t('lights.startFailed')
          : null;
    const statusRow = document.createElement('div');
    statusRow.className = 'lights-status';
    const dot = document.createElement('span');
    dot.className = `lights-status__dot${
      problem ? ' lights-status__dot--warn' : state.playing ? ' lights-status__dot--on' : ''
    }`;
    const statusText = document.createElement('span');
    statusText.textContent =
      problem ??
      (state.playing
        ? t('lights.playing')
        : t('lights.connected', { host: state.bridge?.host ?? '' }));
    statusRow.append(dot, statusText);
    body.appendChild(statusRow);

    const areas = state.areas ?? [];
    if (areas.length) {
      const areaRow = document.createElement('div');
      areaRow.className = 'lights-areas';
      areaRow.setAttribute('role', 'radiogroup');
      for (const area of areas) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `lights-area${area.id === state.area_id ? ' active' : ''}`;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(area.id === state.area_id));
        const radio = document.createElement('span');
        radio.className = 'lights-area__radio';
        const name = document.createElement('span');
        name.textContent = area.name;
        button.append(radio, name);
        button.disabled = saving;
        button.addEventListener('click', () => save({ area_id: area.id }));
        areaRow.appendChild(button);
      }
      body.appendChild(section(t('lights.area'), areaRow));
    } else {
      body.appendChild(section(t('lights.area'), hint(t('lights.noAreas'))));
    }

    body.appendChild(
      section(
        t('lights.style'),
        cards(
          STYLES.map((style) => style.value),
          state.style,
          (style) => save({ style }),
          (value) => t(`lights.styles.${value}`),
          (value) => icon(STYLES.find((style) => style.value === value).icon),
        ),
      ),
    );

    const colourGroup = section(
      t('lights.colour'),
      cards(
        COLOUR_MODES,
        state.colour_mode,
        (colour_mode) => save({ colour_mode }),
        (value) => t(`lights.colourModes.${value}`),
        chip,
      ),
    );
    colourGroup.appendChild(
      hint(
        t(
          state.colour_mode === 'theme'
            ? 'lights.themeHint'
            : state.colour_mode === 'palette'
              ? 'lights.paletteHint'
              : state.colour_mode === 'rotate'
                ? 'lights.rotateHint'
                : 'lights.fixedHint',
        ),
      ),
    );
    if (state.colour_mode === 'fixed') {
      const hue = document.createElement('input');
      hue.type = 'range';
      hue.className = 'lights-hue';
      hue.min = '0';
      hue.max = '359';
      hue.step = '1';
      hue.value = String(hueOf(state.fixed_colour));
      hue.setAttribute('aria-label', t('lights.hue'));
      hue.style.setProperty('--hue-colour', state.fixed_colour);
      hue.disabled = saving;
      hue.addEventListener('input', () => {
        const value = Number(hue.value);
        const colour = hueToHex(value);
        state = { ...state, fixed_colour: colour };
        hue.style.setProperty('--hue-colour', colour);
        const fixedChip = colourGroup.querySelectorAll('.lights-chip')[COLOUR_MODES.indexOf('fixed')];
        if (fixedChip) fixedChip.style.background = colour;
        onChange?.(state);
        clearTimeout(hueTimer);
        hueTimer = setTimeout(() => {
          updateLights({ fixed_colour: colour })
            .then((answer) => answer && setState(answer))
            .catch(() => {
              error = t('lights.saveFailed');
              load();
            });
        }, SAVE_DELAY_MS);
      });
      colourGroup.appendChild(hue);
    }
    body.appendChild(colourGroup);

    const brightnessGroup = section(t('lights.brightness'));
    const brightness = document.createElement('input');
    brightness.type = 'range';
    brightness.className = 'lights-brightness';
    brightness.min = String(MIN_BRIGHTNESS);
    brightness.max = '100';
    brightness.step = '5';
    brightness.value = String(state.brightness);
    brightness.setAttribute('aria-label', t('lights.brightness'));
    // Not disabled while saving: that would end a drag that pauses long
    // enough for a save, as the app's own slider notes.
    paintRange(brightness);
    brightness.addEventListener('input', () => {
      paintRange(brightness);
      const value = Number(brightness.value);
      state = { ...state, brightness: value };
      onChange?.(state);
      clearTimeout(brightnessTimer);
      brightnessTimer = setTimeout(() => {
        updateLights({ brightness: value })
          .then((answer) => answer && setState(answer))
          .catch(() => {
            error = t('lights.saveFailed');
            load();
          });
      }, SAVE_DELAY_MS);
    });
    const brightnessRow = document.createElement('div');
    brightnessRow.className = 'lights-brightness-row';
    brightnessRow.append(icon('mdi-brightness-5'), brightness, icon('mdi-brightness-7'));
    brightnessGroup.appendChild(brightnessRow);
    body.appendChild(brightnessGroup);
  }

  document.body.appendChild(overlay);
  load();
}
