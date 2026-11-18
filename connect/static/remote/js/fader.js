// fader.js — a speaker's row that is its own volume slider, the remote's
// copy of the app's VolumeFader.vue: the fill is the level, a sideways drag
// across the row sets it, a vertical swipe still scrolls the list.

/** How far a finger has to travel sideways before the row takes the
 * gesture. Below it a touch is a tap or the start of a scroll. */
const TOUCH_SLOP_PX = 6;

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.icon            mdi class for the row's icon
 * @param {boolean} [options.master]       the row standing for several speakers
 * @param {boolean} [options.plain]        a name only - its level is set elsewhere
 * @param {string} [options.removeLabel]   shows a remove button with this label
 * @param {(level: number) => void} [options.onInput]   every move
 * @param {(level: number) => void} [options.onCommit]  the level let go on
 * @param {() => void} [options.onRemove]
 */
export function createFader({ label, icon, master = false, plain = false, removeLabel, onInput, onCommit, onRemove }) {
  const row = document.createElement('div');
  row.className = `fader${master ? ' fader--master' : ''}${plain ? ' fader--plain' : ''}`;
  row.innerHTML = `${plain ? '' : '<span class="fader-fill"></span>'}<i class="mdi ${icon} fader-icon"></i><span class="fader-label"></span>${
    plain ? '' : '<span class="fader-value">–</span>'
  }`;
  row.querySelector('.fader-label').textContent = label;
  const value = row.querySelector('.fader-value');

  if (removeLabel) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'fader-remove';
    remove.setAttribute('aria-label', removeLabel);
    remove.innerHTML = '<i class="mdi mdi-close"></i>';
    remove.addEventListener('pointerdown', (event) => event.stopPropagation());
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      onRemove?.();
    });
    row.appendChild(remove);
  }

  let level = null;
  let floor = null;
  let pointer = null;

  function paint() {
    row.style.setProperty('--fader-level', String(level ?? 0));
    if (!value) return;
    if (level == null) value.textContent = '–';
    else value.textContent = floor != null && floor < level ? `${floor}–${level}%` : `${level}%`;
    row.classList.toggle('fader--adjustable', level != null && !plain);
    if (level != null && !plain) {
      row.setAttribute('role', 'slider');
      row.setAttribute('aria-label', label);
      row.setAttribute('aria-valuenow', String(level));
    }
  }

  function levelAt(clientX) {
    const rect = row.getBoundingClientRect();
    const fraction = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  }

  function move(clientX) {
    level = levelAt(clientX);
    paint();
    onInput?.(level);
  }

  function end() {
    if (!pointer) return;
    const taken = pointer.taken;
    pointer = null;
    row.classList.remove('fader--dragging');
    if (taken && level != null) onCommit?.(level);
  }

  row.addEventListener('pointerdown', (event) => {
    if (plain || level == null || event.button !== 0) return;
    pointer = { id: event.pointerId, startX: event.clientX, taken: event.pointerType === 'mouse' };
    row.setPointerCapture?.(event.pointerId);
    if (pointer.taken) {
      row.classList.add('fader--dragging');
      move(event.clientX);
    }
  });
  row.addEventListener('pointermove', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!pointer.taken) {
      if (Math.abs(event.clientX - pointer.startX) < TOUCH_SLOP_PX) return;
      pointer.taken = true;
      row.classList.add('fader--dragging');
    }
    move(event.clientX);
  });
  row.addEventListener('pointerup', (event) => {
    if (pointer?.id === event.pointerId) end();
  });
  // The browser took the gesture over (a vertical scroll): whatever was set
  // so far stands.
  row.addEventListener('pointercancel', end);

  paint();
  return {
    element: row,
    /** A reading from outside. Ignored mid-drag, so it cannot pull the row
     * out from under the finger. */
    set(nextLevel, nextFloor = null) {
      if (pointer?.taken) return;
      level = nextLevel == null ? null : Math.round(nextLevel);
      floor = nextFloor == null ? null : Math.round(nextFloor);
      paint();
    },
    get dragging() {
      return !!pointer?.taken;
    },
  };
}
