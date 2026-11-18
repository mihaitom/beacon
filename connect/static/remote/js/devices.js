// devices.js — the cast sheet, the remote's copy of the app's phone sheet
// (MobileDevicePicker.vue): what is playing on top, each speaker its own
// volume row with "All speakers" as the master over them, and what could be
// added below. A tap adds or stops a speaker straight away - there is no
// selection staged behind a "Done" button any more, the same as the
// desktop's menu.

import { fetchDevices, fetchDeviceVolume, fireCommand, sendReportedCommand } from './api.js';
import { createFader } from './fader.js';
import { state, subscribe } from './state.js';
import { t } from './i18n.js';

const TYPE_ICONS = {
  sonos: 'mdi-speaker-wireless',
  airplay: 'mdi-cast-audio',
  chromecast: 'mdi-cast',
  dlna: 'mdi-television-classic',
};

const TYPE_LABELS = {
  sonos: 'Sonos',
  airplay: 'AirPlay',
  chromecast: 'Chromecast',
  dlna: 'DLNA',
};

// Matches connectStore.isVolumeCapable() in the app.
const VOLUME_TYPES = new Set(['sonos', 'airplay', 'chromecast', 'dlna']);

/** How often an open sheet re-reads who holds which speaker and each
 * speaker's level - the desktop menu's own 4s. */
const REFRESH_MS = 4000;

/** How far the sheet has to be pulled down to close, or how fast. */
const DISMISS_DISTANCE_PX = 96;
const DISMISS_VELOCITY_PX_PER_MS = 0.5;

function deviceKey(device) {
  return `${device.type}:${device.name}`;
}

function casting() {
  return state.snapshot.casting ?? [];
}

function asTarget(device) {
  return { deviceType: device.type, name: device.name };
}

/** One command at a time per control, the last level winning - a drag sends
 * a stream of levels, and a slow speaker would otherwise get a queue of
 * them to work through after the finger has stopped. */
function latestOnly(send) {
  let busy = false;
  let pending = null;
  return function push(value) {
    if (busy) {
      pending = value;
      return;
    }
    busy = true;
    Promise.resolve(send(value))
      .catch(() => {})
      .finally(() => {
        busy = false;
        if (pending != null) {
          const next = pending;
          pending = null;
          push(next);
        }
      });
  };
}

export async function openDevicePicker() {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'cast-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', t('devices.playingOn'));
  sheet.innerHTML = `
    <div class="cast-sheet-top">
      <span class="cast-sheet-grabber" aria-hidden="true"></span>
      <div class="cast-sheet-head">
        <div class="cast-sheet-titles">
          <div class="cast-sheet-title"></div>
          <div class="cast-sheet-subtitle"></div>
        </div>
        <button type="button" class="cast-sheet-round" data-action="rescan"><i class="mdi mdi-refresh"></i></button>
        <button type="button" class="cast-sheet-round" data-action="close"><i class="mdi mdi-close"></i></button>
      </div>
    </div>
    <div class="cast-sheet-body">
      <section class="cast-sheet-playing"></section>
      <section class="cast-sheet-available">
        <div class="eyebrow-label cast-sheet-heading"></div>
        <div class="cast-sheet-groups"><div class="cast-sheet-empty"></div></div>
      </section>
      <div class="cast-sheet-stream"></div>
      <button type="button" class="cast-sheet-stop"></button>
    </div>`;
  sheet.querySelector('.cast-sheet-title').textContent = t('devices.playingOn');
  sheet.querySelector('.cast-sheet-heading').textContent = t('devices.add');
  sheet.querySelector('.cast-sheet-empty').textContent = t('common.loading');
  const rescanBtn = sheet.querySelector('[data-action="rescan"]');
  rescanBtn.setAttribute('aria-label', t('devices.rescan'));
  const closeBtn = sheet.querySelector('[data-action="close"]');
  closeBtn.setAttribute('aria-label', t('common.close'));
  const stopBtn = sheet.querySelector('.cast-sheet-stop');
  stopBtn.textContent = t('devices.stopAll');

  const playingEl = sheet.querySelector('.cast-sheet-playing');
  const groupsEl = sheet.querySelector('.cast-sheet-groups');
  const streamEl = sheet.querySelector('.cast-sheet-stream');
  const subtitleEl = sheet.querySelector('.cast-sheet-subtitle');

  let devices = null;
  let busyKey = null;
  /** Per-speaker levels, read from the speakers themselves. */
  const levels = new Map();
  let master = null;
  const speakerFaders = new Map();
  let shape = '';

  const sendMaster = latestOnly((level) => sendReportedCommand('volume', { volume: level / 100 }));
  const deviceSenders = new Map();
  function sendDevice(device, level) {
    const key = deviceKey(device);
    if (!deviceSenders.has(key)) {
      deviceSenders.set(
        key,
        latestOnly((value) =>
          sendReportedCommand('set-device-volume', { deviceType: device.type, name: device.name, volume: value }),
        ),
      );
    }
    deviceSenders.get(key)(level);
  }

  function volumeTargets() {
    return casting().filter((target) => VOLUME_TYPES.has(target.type));
  }

  function groupMode() {
    return state.snapshot.group_volume_mode === 'relative' ? 'relative' : 'equal';
  }

  // ── What is playing ──

  function renderPlaying() {
    playingEl.replaceChildren();
    master = null;
    speakerFaders.clear();
    const targets = casting();
    const tracked = volumeTargets();
    const grouped = tracked.length > 1;

    subtitleEl.textContent = targets.length
      ? targets.length === 1
        ? t('devices.oneSpeaker')
        : t('devices.speakerCount', { n: targets.length })
      : t('devices.thisDevice');

    if (!targets.length) {
      const here = document.createElement('div');
      here.className = 'cast-sheet-here';
      here.innerHTML = '<i class="mdi mdi-laptop"></i><span></span><i class="mdi mdi-check-circle"></i>';
      here.querySelector('span').textContent = t('devices.thisDevice');
      playingEl.appendChild(here);
      return;
    }

    if (grouped) playingEl.appendChild(buildModeSwitch());

    const list = document.createElement('div');
    list.className = 'cast-sheet-faders';
    if (grouped) {
      master = createFader({
        label: t('devices.allSpeakers'),
        icon: 'mdi-speaker-multiple',
        master: true,
        onInput: sendMaster,
        // The speakers' own levels moved with it; read them back.
        onCommit: () => setTimeout(readLevels, 600),
      });
      list.appendChild(master.element);
    }
    const plainRows = grouped && groupMode() === 'equal';
    for (const target of targets) {
      const adjustable = VOLUME_TYPES.has(target.type);
      const fader = createFader({
        label: target.name,
        icon: TYPE_ICONS[target.type] ?? 'mdi-speaker',
        plain: plainRows || !adjustable,
        removeLabel: t('devices.removeSpeaker', { name: target.name }),
        onInput: (level) => {
          levels.set(deviceKey(target), level);
          sendDevice(target, level);
          paintMaster();
        },
        onRemove: () => remove(target),
      });
      speakerFaders.set(deviceKey(target), fader);
      list.appendChild(fader.element);
    }
    playingEl.appendChild(list);

    const local = document.createElement('button');
    local.type = 'button';
    local.className = 'cast-sheet-local';
    local.innerHTML = '<i class="mdi mdi-laptop"></i><span></span>';
    local.querySelector('span').textContent = t('devices.playHereInstead');
    local.addEventListener('click', stopAll);
    playingEl.appendChild(local);

    paintLevels();
  }

  function buildModeSwitch() {
    const group = document.createElement('div');
    group.className = 'segmented';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', t('devices.groupVolume'));
    for (const [mode, label] of [
      ['equal', t('devices.groupEqual')],
      ['relative', t('devices.groupRelative')],
    ]) {
      const option = document.createElement('button');
      option.type = 'button';
      option.setAttribute('role', 'radio');
      option.textContent = label;
      const active = groupMode() === mode;
      option.classList.toggle('active', active);
      option.setAttribute('aria-checked', String(active));
      option.addEventListener('click', () => {
        if (groupMode() === mode) return;
        fireCommand('group-volume-mode', { mode });
      });
      group.appendChild(option);
    }
    return group;
  }

  function paintMaster() {
    if (!master) return;
    const known = volumeTargets()
      .map((target) => levels.get(deviceKey(target)))
      .filter((level) => level != null);
    const floor = groupMode() === 'relative' && known.length ? Math.min(...known) : null;
    master.set(state.snapshot.device_volume, floor);
  }

  function paintLevels() {
    paintMaster();
    for (const target of casting()) {
      const fader = speakerFaders.get(deviceKey(target));
      if (!fader) continue;
      // A single speaker's level is also the snapshot's own reading, which
      // follows a change made anywhere else without waiting for a poll.
      const level =
        casting().length === 1 && state.snapshot.device_volume != null
          ? state.snapshot.device_volume
          : levels.get(deviceKey(target));
      fader.set(level ?? null);
    }
  }

  async function readLevels() {
    const targets = volumeTargets();
    await Promise.all(
      targets.map(async (target) => {
        try {
          const { volume } = await fetchDeviceVolume(target.type, target.name);
          if (volume != null) levels.set(deviceKey(target), Math.round(volume));
        } catch {
          // Stays at the last reading.
        }
      }),
    );
    if (sheet.isConnected) paintLevels();
  }

  // ── What could be added ──

  function renderAvailable() {
    groupsEl.replaceChildren();
    if (!devices) return;
    const active = new Set(casting().map(deviceKey));
    const available = devices.filter((device) => !active.has(deviceKey(device)));
    if (!available.length) {
      const empty = document.createElement('div');
      empty.className = 'cast-sheet-empty';
      empty.textContent = devices.length ? t('devices.allInUse') : t('devices.noneFound');
      groupsEl.appendChild(empty);
      return;
    }
    // `devices` arrives grouped and ordered by type (see the app's
    // devices-request), so a new panel starts wherever the type changes.
    let panel = null;
    let lastType = null;
    for (const device of available) {
      if (device.type !== lastType) {
        lastType = device.type;
        const label = document.createElement('div');
        label.className = 'cast-sheet-type';
        label.textContent = TYPE_LABELS[device.type] ?? device.type;
        panel = document.createElement('div');
        panel.className = 'cast-sheet-panel';
        groupsEl.append(label, panel);
      }
      panel.appendChild(buildAvailableRow(device));
    }
  }

  function buildAvailableRow(device) {
    const row = document.createElement('div');
    row.className = 'cast-sheet-row';
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'cast-sheet-row-main';
    main.setAttribute('aria-label', t('devices.addSpeaker', { name: device.name }));
    main.innerHTML = `<i class="mdi ${TYPE_ICONS[device.type] ?? 'mdi-speaker'} cast-sheet-tile"></i><span class="cast-sheet-row-text"><span class="cast-sheet-row-name"></span></span>`;
    main.querySelector('.cast-sheet-row-name').textContent = device.name;
    const text = main.querySelector('.cast-sheet-row-text');
    const note = (className, content) => {
      const line = document.createElement('span');
      line.className = className;
      line.textContent = content;
      text.appendChild(line);
    };

    // No PIN-entry flow on the phone - the pairing handshake needs the
    // app's own dialog - so an unpaired AirPlay speaker says so instead of
    // vanishing from the list.
    if (device.needs_pairing) {
      main.disabled = true;
      row.classList.add('cast-sheet-row--blocked');
      note('cast-sheet-row-note', t('devices.needsPairing'));
      row.appendChild(main);
      return row;
    }

    if (device.claimed) {
      // Taking a speaker from somebody is its own deliberate button, not a
      // tap on the row.
      main.disabled = true;
      note(
        'cast-sheet-row-claimed',
        device.in_use_by_name ? t('devices.inUseBy', { name: device.in_use_by_name }) : t('devices.inUseByUnknown'),
      );
      if (device.in_use_by_song) note('cast-sheet-row-note', device.in_use_by_song);
      const takeOver = document.createElement('button');
      takeOver.type = 'button';
      takeOver.className = 'cast-sheet-takeover';
      takeOver.textContent = t('devices.takeOver');
      takeOver.addEventListener('click', () => add(device));
      row.append(main, takeOver);
      return row;
    }

    if (busyKey === deviceKey(device)) {
      main.insertAdjacentHTML('beforeend', '<i class="mdi mdi-loading mdi-spin cast-sheet-add"></i>');
    } else {
      main.insertAdjacentHTML('beforeend', '<i class="mdi mdi-plus cast-sheet-add"></i>');
    }
    main.addEventListener('click', () => add(device));
    row.appendChild(main);
    return row;
  }

  // ── Actions ──

  /** Adds a speaker to what is playing. cast-to-many is the complete
   * target set and always forces, so this is also how a speaker someone
   * else holds is taken over. */
  async function add(device) {
    if (busyKey) return;
    busyKey = deviceKey(device);
    renderAvailable();
    try {
      await sendReportedCommand('cast-to-many', { targets: [...casting().map(asTarget), asTarget(device)] });
    } catch {
      // The failure banner is already up (api.js).
    } finally {
      busyKey = null;
      if (sheet.isConnected) renderAvailable();
    }
  }

  /** One speaker stops; the rest keep playing. The last one hands back to
   * the app, same as "Stop all". */
  function remove(target) {
    const rest = casting().filter((other) => deviceKey(other) !== deviceKey(target));
    fireCommand('cast-to-many', { targets: rest.map(asTarget) });
  }

  /** Nothing is left to adjust once the sound is back in the app. */
  function stopAll() {
    fireCommand('cast-stop');
    close();
  }
  stopBtn.addEventListener('click', stopAll);

  // ── Keeping it current ──

  function renderStream() {
    const info = buildStreamInfo();
    streamEl.replaceChildren(...(info ? [info] : []));
    stopBtn.hidden = casting().length === 0;
  }

  // The rows are rebuilt only when the speakers or the mode change - a
  // rebuild mid-drag would take the row from under the finger. Everything
  // else a snapshot brings is a new level, painted onto the rows there are.
  function targetsShape() {
    return casting().map(deviceKey).join('|');
  }

  function render() {
    shape = `${targetsShape()}#${groupMode()}`;
    renderPlaying();
    renderAvailable();
    renderStream();
  }

  let streamShape = JSON.stringify(state.snapshot.stream_info ?? null);
  const unsubscribe = subscribe(() => {
    const targetsBefore = shape.split('#')[0];
    if (`${targetsShape()}#${groupMode()}` !== shape) {
      render();
      if (targetsShape() !== targetsBefore) void readLevels();
    } else {
      paintLevels();
    }
    const nextStream = JSON.stringify(state.snapshot.stream_info ?? null);
    if (nextStream !== streamShape) {
      streamShape = nextStream;
      renderStream();
    }
  });

  async function loadDevices(rescan = false) {
    try {
      ({ items: devices } = await fetchDevices({ rescan }));
    } catch {
      if (!devices) {
        groupsEl.replaceChildren();
        const failed = document.createElement('div');
        failed.className = 'cast-sheet-empty';
        failed.textContent = t('devices.failed');
        groupsEl.appendChild(failed);
      }
      return;
    }
    if (sheet.isConnected) renderAvailable();
  }

  rescanBtn.addEventListener('click', async () => {
    if (rescanBtn.disabled) return;
    rescanBtn.disabled = true;
    rescanBtn.classList.add('cast-sheet-round--busy');
    try {
      await loadDevices(true);
    } finally {
      rescanBtn.disabled = false;
      rescanBtn.classList.remove('cast-sheet-round--busy');
    }
  });

  const refreshTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void loadDevices();
    // Only where a speaker's own level is on show: with one level for
    // all, the master in the snapshot is the only number there is.
    if (casting().length === 1 || groupMode() === 'relative') void readLevels();
  }, REFRESH_MS);

  // ── Opening and closing ──

  function close() {
    clearInterval(refreshTimer);
    unsubscribe();
    document.removeEventListener('keydown', onKey);
    sheet.classList.add('cast-sheet--leaving');
    backdrop.classList.add('sheet-backdrop--leaving');
    sheet.style.transform = '';
    const done = () => {
      backdrop.remove();
      sheet.remove();
    };
    sheet.addEventListener('transitionend', done, { once: true });
    // In case nothing transitions (reduced motion).
    setTimeout(done, 350);
  }

  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  enableDragToClose(sheet.querySelector('.cast-sheet-top'), sheet, close);

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  // Next frame, so the slide-in has a starting point to slide from.
  requestAnimationFrame(() => sheet.classList.add('cast-sheet--open'));

  render();
  void readLevels();
  await loadDevices();
}

/** Pulling the sheet down by its top closes it, the way a phone's own
 * sheets do. The list scrolls and is left to do that. */
function enableDragToClose(handle, sheet, close) {
  let drag = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    drag = { id: event.pointerId, startY: event.clientY, lastY: event.clientY, lastTime: event.timeStamp, velocity: 0, offset: 0 };
    handle.setPointerCapture?.(event.pointerId);
    sheet.classList.add('cast-sheet--dragging');
  });
  handle.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag.velocity = (event.clientY - drag.lastY) / Math.max(1, event.timeStamp - drag.lastTime);
    drag.lastY = event.clientY;
    drag.lastTime = event.timeStamp;
    drag.offset = Math.max(0, event.clientY - drag.startY);
    sheet.style.transform = `translateY(${drag.offset}px)`;
  });
  const end = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dismiss =
      drag.offset > DISMISS_DISTANCE_PX || (drag.offset > 0 && drag.velocity > DISMISS_VELOCITY_PX_PER_MS);
    drag = null;
    sheet.classList.remove('cast-sheet--dragging');
    if (dismiss) close();
    else sheet.style.transform = '';
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/** What the speakers are being sent, and what it was made from - the same
 * two lines the app's cast menus end with. Both arrive as finished text in
 * the snapshot (see stores/remoteControl.ts): the formatting lives in one
 * place over there, not a second time here. Absent whenever nothing is
 * being cast.
 *
 * The labels are StreamInfoSection.vue's own wording (see js/locales/) - a
 * second set of words for the same two rows read as two different readings
 * of the stream. */
function buildStreamInfo() {
  const info = state.snapshot.stream_info;
  if (!info) return null;
  // Whether the audio is being re-encoded or handed over untouched is the
  // one thing here worth reading at a glance, before the format name.
  const rows = [
    {
      label: t('streamInfo.transcoding'),
      value: info.transcoding ? info.target : t('streamInfo.directCopy'),
      icon: info.transcoding ? 'mdi-cog-sync-outline' : 'mdi-check-circle-outline',
      tone: info.transcoding ? 'warn' : 'ok',
    },
  ];
  if (info.source) rows.push({ label: t('streamInfo.source'), value: info.source });
  const box = document.createElement('div');
  box.className = 'sheet-stream-info';
  box.innerHTML =
    `<div class="eyebrow-label stream-info-heading">${t('streamInfo.title')}</div>` +
    rows
      .map(
        ({ label, value, icon, tone }) =>
          `<div class="stream-info-row"><span class="muted">${escapeHtml(label)}</span><span class="stream-info-value">${
            icon ? `<i class="mdi ${icon} stream-info-icon stream-info-icon--${tone}"></i>` : ''
          }${escapeHtml(value)}</span></div>`,
      )
      .join('');
  return box;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
