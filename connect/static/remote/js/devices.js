// devices.js — cast target picker (bottom sheet), mirrors sheet.js's
// structure but needs its own module: it fetches the device list on open,
// groups/orders/icons it the same way the desktop's own
// ConnectDevicePicker.vue does (so "which icon means which brand" reads the
// same on both), and is a genuine multi-select — each eligible row is a
// checkbox (pre-checked for whatever's already active), and a "Done" button
// applies the resulting set as a single cast-to-many command. Volume rows
// are independent of that pending selection — they reflect what's actually
// playing right now (state.js's snapshot.casting), not what's checked.

import { sendCommand, fetchDevices, fetchDeviceVolume } from './api.js';
import { state } from './state.js';
import { paintRange } from './range.js';

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

function deviceKey(device) {
  return `${device.type}:${device.name}`;
}

function isActive(device) {
  return state.snapshot.casting?.some((t) => t.type === device.type && t.name === device.name) ?? false;
}

export async function openDevicePicker() {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = '<div class="sheet-header">Play on</div><div class="sheet-loading">Loading…</div>';

  function close() {
    backdrop.remove();
    sheet.remove();
  }

  backdrop.addEventListener('click', close);
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);

  let devices;
  try {
    ({ items: devices } = await fetchDevices());
  } catch {
    sheet.innerHTML = '<div class="sheet-header">Play on</div><div class="sheet-loading">Couldn’t load devices</div>';
    return;
  }

  sheet.innerHTML = '<div class="sheet-header">Play on</div>';

  // Pre-checked with whatever's already casting — matches DeviceListItem.vue's
  // own `checked = isMyActiveTarget || selected` starting point.
  const selectedKeys = new Set(devices.filter((d) => !d.needs_pairing && isActive(d)).map(deviceKey));
  // Snapshot of the starting selection, so Done can tell "nothing actually
  // changed" apart from "same set of devices, re-confirmed" — sending
  // cast-to-many when nothing changed would still re-dispatch /play to
  // already-playing devices for no reason (an audible restart/reconnect,
  // not a no-op on the backend side).
  const initialKeys = new Set(selectedKeys);
  const selectionUnchanged = () =>
    selectedKeys.size === initialKeys.size && [...selectedKeys].every((key) => initialKeys.has(key));

  // Created up front so the row toggle handlers below can update it, but
  // appended to the sheet after the list (see the bottom of this function) —
  // right-aligned (most people hold/tap a phone right-handed) and only
  // accent-colored once at least one device is checked, so "Done" reads as
  // "nothing to apply yet" vs. "ready to switch" at a glance.
  const doneBtn = document.createElement('button');
  doneBtn.className = 'btn-sheet-action';
  doneBtn.textContent = 'Done';
  function updateDoneButton() {
    doneBtn.classList.toggle('btn-sheet-action--active', selectedKeys.size > 0);
  }

  const list = document.createElement('div');
  list.className = 'device-list';

  const localRow = document.createElement('button');
  localRow.innerHTML = '<i class="mdi mdi-speaker"></i><span>This device</span>';
  localRow.addEventListener('click', () => {
    sendCommand('cast-stop');
    close();
  });
  list.appendChild(localRow);

  // Grouped/ordered like the desktop's ConnectDevicePicker.vue (TYPE_ORDER) —
  // `devices` already arrives pre-sorted in that order from commands.ts, so
  // a header just needs to be inserted whenever the type changes.
  let lastType = null;
  for (const device of devices) {
    if (device.type !== lastType) {
      lastType = device.type;
      const header = document.createElement('div');
      header.className = 'sheet-header';
      header.textContent = TYPE_LABELS[device.type] ?? device.type;
      list.appendChild(header);
    }

    const row = document.createElement('button');
    const icon = TYPE_ICONS[device.type] ?? 'mdi-cast';

    if (device.needs_pairing) {
      // No PIN-entry flow exists on the phone (see commands.ts's own
      // comment) — shown greyed out with an explanation instead of just
      // vanishing, so an unpaired AirPlay speaker doesn't read as "Beacon
      // can't see it at all".
      row.className = 'device-row-disabled';
      row.disabled = true;
      row.innerHTML = `<i class="mdi ${icon}"></i><span>${escapeHtml(device.name)}<br /><span class="muted device-row-hint">Pair from the Beacon app first</span></span><i class="mdi mdi-lock-outline device-row-check"></i>`;
      list.appendChild(row);
      continue;
    }

    const key = deviceKey(device);
    const renderCheck = () =>
      selectedKeys.has(key) ? '<i class="mdi mdi-check device-row-check"></i>' : '';
    row.innerHTML = `<i class="mdi ${icon}"></i><span>${escapeHtml(device.name)}${
      device.in_use_by_name ? ` <span class="muted">(${escapeHtml(device.in_use_by_name)})</span>` : ''
    }</span>${renderCheck()}`;
    row.addEventListener('click', () => {
      if (selectedKeys.has(key)) selectedKeys.delete(key);
      else selectedKeys.add(key);
      row.querySelector('.device-row-check')?.remove();
      if (selectedKeys.has(key)) row.insertAdjacentHTML('beforeend', '<i class="mdi mdi-check device-row-check"></i>');
      updateDoneButton();
    });
    list.appendChild(row);

    // Per-device volume, shown for every *currently active* volume-capable
    // target — independent of the pending checkbox state above. With 2+
    // active targets this is the only place any of them gets a slider at
    // all (see stores/remoteControl.ts's own comment on why the Now Playing
    // screen's single slider only ever represents exactly one). Fetched
    // once on open rather than polled continuously — this sheet is a
    // short-lived popover, not worth the same standing 4s poll
    // DeviceListItem.vue/startDeviceVolumePoll() run for it.
    if (isActive(device) && device.volume_capable) {
      const volumeRow = document.createElement('div');
      volumeRow.className = 'device-volume-row';
      volumeRow.innerHTML =
        '<i class="mdi mdi-volume-high"></i><input type="range" min="0" max="100" step="1" value="0" disabled />';
      list.appendChild(volumeRow);

      const slider = volumeRow.querySelector('input');
      paintRange(slider);
      fetchDeviceVolume(device.type, device.name)
        .then(({ volume }) => {
          if (volume == null) return; // stays disabled — e.g. a DLNA renderer without volume support
          slider.value = String(volume);
          slider.disabled = false;
          paintRange(slider);
        })
        .catch(() => {});
      slider.addEventListener('input', () => paintRange(slider));
      slider.addEventListener('change', () => {
        sendCommand('set-device-volume', { deviceType: device.type, name: device.name, volume: Number(slider.value) });
      });
    }
  }

  sheet.appendChild(list);

  updateDoneButton();
  doneBtn.addEventListener('click', () => {
    if (!selectionUnchanged()) {
      const targets = [...selectedKeys].map((key) => {
        const [deviceType, ...rest] = key.split(':');
        return { deviceType, name: rest.join(':') };
      });
      sendCommand('cast-to-many', { targets });
    }
    close();
  });
  const footer = document.createElement('div');
  footer.className = 'sheet-footer';
  footer.appendChild(doneBtn);
  sheet.appendChild(footer);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
