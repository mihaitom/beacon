// equalizer.js — the equalizer for the speaker being cast to, opened from
// Now Playing's toolbar. The app's own EqualizerDialog is the full thing
// (imported profiles, saving presets, the curve's own response); this is
// the part that makes sense from a phone: switch it on, pick a preset,
// drag the ten points, and hear it now.
//
// A dialog rather than a bottom sheet: the desktop's own form, and a
// clearly visible Done button in the footer means there is always a way
// back out of it.

import { fetchEqualizer, sendReportedCommand } from './api.js';
import { state } from './state.js';
import { t } from './i18n.js';

const BAND_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const MAX_GAIN = 12;
// The curve's drawing box: the graph runs from 31 Hz to 16 kHz, with room
// beside the edge points so a handle at the end is not cut in half.
const GRAPH_WIDTH = 320;
const GRAPH_HEIGHT = 170;
const GRAPH_PAD_X = 18;
const GRAPH_PAD_Y = 16;
// Same wait as the app's own speaker curve: every save is a round trip to
// connect and the account, and a drag would otherwise send one per step.
const SAVE_DELAY_MS = 200;

function clampGain(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-MAX_GAIN, Math.min(MAX_GAIN, Math.round(number)));
}

function sanitizeSetting(value) {
  const gains = Array.isArray(value?.gains) ? value.gains : [];
  return {
    enabled: value?.enabled === true,
    gains: BAND_FREQUENCIES.map((_, index) => clampGain(gains[index])),
    ...(value?.profile ? { profile: value.profile } : {}),
  };
}

function sameGains(a, b) {
  return a.length === b.length && a.every((gain, index) => gain === b[index]);
}

function targetKey(target) {
  return `${target.type}:${target.name}`;
}

function compactFrequency(frequency) {
  return frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);
}

function gainLabel(gain) {
  return `${gain > 0 ? '+' : ''}${gain} dB`;
}

function bandX(index) {
  return GRAPH_PAD_X + index * ((GRAPH_WIDTH - 2 * GRAPH_PAD_X) / (BAND_FREQUENCIES.length - 1));
}

function gainY(gain) {
  const half = GRAPH_HEIGHT / 2;
  return half - (gain / MAX_GAIN) * (half - GRAPH_PAD_Y);
}

function gainAt(y) {
  const half = GRAPH_HEIGHT / 2;
  return clampGain(((half - y) / (half - GRAPH_PAD_Y)) * MAX_GAIN);
}

export function openEqualizer() {
  // Never stack two; a second open replaces whatever was there.
  document.querySelectorAll('.eq-overlay').forEach((element) => element.remove());

  const overlay = document.createElement('div');
  overlay.className = 'eq-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'eq-dialog';
  dialog.innerHTML = `
    <div class="eq-dialog__head">
      <div class="eq-dialog__heading">
        <div class="eyebrow-label" id="eq-subject"></div>
        <div class="eq-dialog__title">${t('equalizer.title')}</div>
      </div>
      <button type="button" class="eq-dialog__close" aria-label="${t('common.close')}">
        <i class="mdi mdi-close"></i>
      </button>
    </div>
    <div class="eq-dialog__body"><div class="empty-state">${t('common.loading')}</div></div>
    <div class="eq-dialog__footer">
      <button type="button" class="btn btn-secondary eq-apply" disabled>${t('equalizer.applyNow')}</button>
      <button type="button" class="btn btn-primary eq-done">${t('common.done')}</button>
    </div>
  `;
  overlay.appendChild(dialog);

  const body = dialog.querySelector('.eq-dialog__body');
  const subject = dialog.querySelector('#eq-subject');
  const applyButton = dialog.querySelector('.eq-apply');
  const doneButton = dialog.querySelector('.eq-done');
  const closeButton = dialog.querySelector('.eq-dialog__close');

  let data = null;
  let target = null;
  let setting = sanitizeSetting(null);
  let saveTimer = null;
  let dragging = null;
  let enableInput = null;
  let graphSvg = null;
  let readout = null;
  let graphParts = null;

  function close() {
    flush();
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
  document.addEventListener('keydown', onKey);

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY_MS);
  }

  function flush() {
    if (!saveTimer) return Promise.resolve();
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!target) return Promise.resolve();
    return sendReportedCommand('set-equalizer', { target, setting }).catch(() => {});
  }

  applyButton.addEventListener('click', async () => {
    // The curve first, then the restart: the other way round it would
    // restart with the previous curve and the change would wait for the
    // next song, which is exactly what this button exists to avoid.
    applyButton.disabled = true;
    try {
      await flush();
      await sendReportedCommand('equalizer-apply', {});
    } catch {
      // The shared banner already reported it.
    } finally {
      applyButton.disabled = !canApply();
    }
  });

  function canApply() {
    return Boolean(state.snapshot.current_song) && !state.snapshot.radio;
  }

  function presetValue() {
    if (setting.profile) return `custom:${setting.profile.name}`;
    for (const preset of data?.built_in ?? []) {
      if (sameGains(setting.gains, preset.gains)) return preset.name;
    }
    for (const preset of data?.presets ?? []) {
      if (!preset.profile && sameGains(setting.gains, preset.gains)) return `custom:${preset.name}`;
    }
    return 'custom';
  }

  function selectPreset(value) {
    const own = value.startsWith('custom:')
      ? (data?.presets ?? []).find((preset) => `custom:${preset.name}` === value)
      : null;
    if (own?.profile) {
      setting = { ...setting, profile: own.profile, enabled: true };
    } else if (own) {
      setting = { gains: [...own.gains], profile: null, enabled: true };
    } else {
      const builtIn = (data?.built_in ?? []).find((preset) => preset.name === value);
      if (!builtIn) return;
      // A flat curve stays as switched on as it already was, exactly like
      // the app's own picker.
      setting = {
        gains: [...builtIn.gains],
        profile: null,
        enabled: value !== 'flat' || setting.enabled,
      };
    }
    render();
    scheduleSave();
  }

  function load() {
    body.innerHTML = `<div class="empty-state">${t('common.loading')}</div>`;
    applyButton.disabled = true;
    fetchEqualizer()
      .then((answer) => {
        data = answer;
        const targets = answer.targets ?? [];
        if (!targets.length) {
          subject.textContent = '';
          body.innerHTML = `<div class="empty-state">${t('equalizer.unavailable')}</div>`;
          return;
        }
        const preferred = target && targets.find((entry) => targetKey(entry) === targetKey(target));
        target = preferred ?? targets[0];
        setting = sanitizeSetting(answer.settings?.[targetKey(target)]);
        render();
      })
      .catch(() => {
        subject.textContent = '';
        body.innerHTML = `<div class="empty-state">${t('equalizer.failed')}</div>`;
      });
  }

  /** The switch, the preset picker and the curve, in the desktop dialog's
   * order. Rebuilt when the target or the preset changes; the curve itself
   * repaints in place while a finger drags it. */
  function render() {
    body.innerHTML = '';
    subject.textContent = target?.name ?? '';
    enableInput = null;
    graphSvg = null;
    readout = null;
    graphParts = null;

    if ((data?.targets ?? []).length > 1) {
      const targets = document.createElement('div');
      targets.className = 'segmented';
      for (const entry of data.targets) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = entry.name;
        button.className = targetKey(entry) === targetKey(target) ? 'active' : '';
        button.addEventListener('click', () => {
          flush();
          target = entry;
          setting = sanitizeSetting(data.settings?.[targetKey(entry)]);
          render();
        });
        targets.appendChild(button);
      }
      body.appendChild(targets);
    }

    const switchRow = document.createElement('label');
    switchRow.className = 'eq-switch';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = setting.enabled;
    checkbox.addEventListener('change', () => {
      setting = { ...setting, enabled: checkbox.checked };
      paintGraph();
      scheduleSave();
    });
    enableInput = checkbox;
    const track = document.createElement('span');
    track.className = 'eq-switch__track';
    const thumb = document.createElement('span');
    thumb.className = 'eq-switch__thumb';
    track.appendChild(thumb);
    const switchLabel = document.createElement('span');
    switchLabel.className = 'eq-switch__label';
    switchLabel.textContent = t('equalizer.enabled');
    switchRow.append(checkbox, track, switchLabel);
    body.appendChild(switchRow);

    if (setting.profile) {
      const profile = document.createElement('div');
      profile.className = 'eq-profile';
      profile.textContent = `${t('equalizer.profile')}: ${setting.profile.name}`;
      body.appendChild(profile);
    }

    const presetField = document.createElement('div');
    presetField.className = 'eq-preset-field';
    const presetLabel = document.createElement('label');
    presetLabel.textContent = t('equalizer.preset');
    const select = document.createElement('select');
    select.className = 'eq-select';
    const active = presetValue();
    const entries = [
      ...(data?.built_in ?? []).map((preset) => ({
        value: preset.name,
        label: t(`equalizer.presets.${preset.name}`),
      })),
      ...(data?.presets ?? []).map((preset) => ({
        value: `custom:${preset.name}`,
        label: preset.name,
      })),
    ];
    const known = new Set(entries.map((entry) => entry.value));
    if (active === 'custom') {
      entries.push({ value: 'custom', label: t('equalizer.custom') });
    } else if (!known.has(active) && setting.profile) {
      entries.push({ value: active, label: setting.profile.name });
    }
    for (const entry of entries) {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      // Only a label for a curve that matches nothing, not a choice.
      option.disabled = entry.value === 'custom';
      select.appendChild(option);
    }
    select.value = active;
    select.addEventListener('change', () => selectPreset(select.value));
    presetField.append(presetLabel, select);
    body.appendChild(presetField);

    // An imported profile plays exactly as measured; its own curve is not
    // ten gains, so there is nothing here to put ten handles on. Picking a
    // preset above takes it off.
    if (!setting.profile) {
      body.appendChild(renderGraph());
    }

    const hint = document.createElement('p');
    hint.className = 'eq-hint';
    hint.textContent = t('equalizer.hint');
    body.appendChild(hint);

    applyButton.disabled = !canApply();
  }

  function renderGraph() {
    const wrapper = document.createElement('div');
    wrapper.className = 'eq-graph-wrap';
    readout = document.createElement('div');
    readout.className = 'eq-readout hidden';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`);
    svg.setAttribute('class', 'eq-graph');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t('equalizer.title'));
    graphSvg = svg;

    const grid = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    grid.setAttribute('class', 'eq-graph__grid');
    for (const gain of [-12, -6, 0, 6, 12]) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(GRAPH_PAD_X));
      line.setAttribute('x2', String(GRAPH_WIDTH - GRAPH_PAD_X));
      line.setAttribute('y1', String(gainY(gain)));
      line.setAttribute('y2', String(gainY(gain)));
      if (gain === 0) line.setAttribute('class', 'eq-graph__zero');
      grid.appendChild(line);
    }
    svg.appendChild(grid);

    const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('class', 'eq-graph__area');
    const curve = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    curve.setAttribute('class', 'eq-graph__curve');
    svg.append(area, curve);

    const handles = BAND_FREQUENCIES.map((frequency, index) => {
      const handle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      handle.setAttribute('class', 'eq-handle');
      handle.setAttribute('r', '7');
      handle.setAttribute('cx', String(bandX(index)));
      handle.setAttribute('cy', String(gainY(setting.gains[index])));
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${compactFrequency(frequency)} Hz · ${gainLabel(setting.gains[index])}`;
      handle.appendChild(title);
      svg.appendChild(handle);
      return handle;
    });

    graphParts = { area, curve, handles };

    const frequencies = document.createElement('div');
    frequencies.className = 'eq-graph__freqs';
    for (const frequency of BAND_FREQUENCIES) {
      const label = document.createElement('span');
      label.textContent = compactFrequency(frequency);
      frequencies.appendChild(label);
    }

    wrapper.append(readout, svg, frequencies);
    paintGraph();
    wireGraph(svg);
    return wrapper;
  }

  function paintGraph() {
    if (!graphSvg || !graphParts) return;
    const points = setting.gains.map((gain, index) => [bandX(index), gainY(gain)]);
    const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ');
    graphParts.curve.setAttribute('d', line);
    const first = points[0];
    const last = points[points.length - 1];
    graphParts.area.setAttribute(
      'd',
      `${line} L${last[0]} ${GRAPH_HEIGHT / 2} L${first[0]} ${GRAPH_HEIGHT / 2} Z`,
    );
    graphParts.handles.forEach((handle, index) => {
      handle.setAttribute('cx', String(points[index][0]));
      handle.setAttribute('cy', String(points[index][1]));
      handle.classList.toggle('eq-handle--active', index === dragging);
    });
    graphSvg.classList.toggle('eq-graph--off', !setting.enabled);
  }

  function nearestBand(clientX) {
    const rect = graphSvg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * GRAPH_WIDTH;
    let nearest = 0;
    let distance = Infinity;
    for (let index = 0; index < BAND_FREQUENCIES.length; index++) {
      const candidate = Math.abs(bandX(index) - x);
      if (candidate < distance) {
        distance = candidate;
        nearest = index;
      }
    }
    return nearest;
  }

  function gainFromEvent(event) {
    const rect = graphSvg.getBoundingClientRect();
    const y = ((event.clientY - rect.top) / rect.height) * GRAPH_HEIGHT;
    return gainAt(y);
  }

  function applyGain(index, gain) {
    const gains = [...setting.gains];
    gains[index] = clampGain(gain);
    // Moving a point is wanting to hear it.
    setting = { ...setting, gains, profile: null, enabled: true };
    if (enableInput) enableInput.checked = true;
    paintGraph();
    if (readout) {
      readout.classList.remove('hidden');
      readout.textContent = `${compactFrequency(BAND_FREQUENCIES[index])} Hz · ${gainLabel(
        gains[index],
      )}`;
    }
    scheduleSave();
  }

  function wireGraph(svg) {
    svg.addEventListener('pointerdown', (event) => {
      dragging = nearestBand(event.clientX);
      svg.setPointerCapture(event.pointerId);
      applyGain(dragging, gainFromEvent(event));
      event.preventDefault();
    });
    svg.addEventListener('pointermove', (event) => {
      if (dragging === null) return;
      applyGain(dragging, gainFromEvent(event));
      event.preventDefault();
    });
    const release = () => {
      if (dragging === null) return;
      const wasDragging = dragging;
      dragging = null;
      paintGraph();
      if (readout && wasDragging !== null) readout.classList.remove('hidden');
    };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointercancel', release);
  }

  document.body.appendChild(overlay);
  load();
}
