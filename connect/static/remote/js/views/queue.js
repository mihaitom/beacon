import { sendCommand } from '../api.js';
import { registerRoute } from '../router.js';
import { state, subscribe } from '../state.js';
import { createArt } from '../art.js';

// Pointer-based drag-to-reorder (works for touch and mouse alike, unlike
// HTML5 drag-and-drop which touch browsers don't fire reliably without a
// dedicated "drag handle" long-press gesture anyway) — a fixed handle icon
// starts the drag, rows swap live as the pointer crosses their midpoint,
// and the final position is sent as one queue-reorder command on release.

export function renderQueue(root) {
  root.innerHTML = '<div class="list" id="queue-list"></div>';
  const list = root.querySelector('#queue-list');

  let localQueue = [];
  let dragFrom = null;
  let dragEl = null;
  // render() fires on every snapshot tick — several times a second while
  // playing (position updates), not just when the queue itself changes.
  // Rebuilding every row's DOM (and, now that art.js uses real <img>
  // elements instead of a CSS background, re-triggering every cover's
  // image load) on every one of those would flicker constantly — skip the
  // rebuild unless the queue's actual contents changed.
  let lastKey = null;

  function renderList(queue, currentIndex) {
    const key = `${queue.map((t) => t.id).join(',')}|${currentIndex}`;
    if (key === lastKey) return;
    lastKey = key;

    list.innerHTML = '';
    if (!queue.length) {
      list.innerHTML = '<div class="empty-state">Queue is empty</div>';
      return;
    }
    queue.forEach((track, index) => {
      const row = document.createElement('div');
      row.className = 'row' + (index === currentIndex ? ' playing' : '');
      row.dataset.index = String(index);

      row.appendChild(createArt(track.cover_art_url, null));

      const main = document.createElement('div');
      main.className = 'row-main';
      main.addEventListener('click', () => sendCommand('queue-jump', { index }));
      main.innerHTML = `<div class="row-title">${escapeHtml(track.title)}</div><div class="row-subtitle">${escapeHtml(track.artist || '')}</div>`;
      row.appendChild(main);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'row-action';
      removeBtn.innerHTML = '<i class="mdi mdi-close"></i>';
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        sendCommand('queue-remove', { index });
      });
      row.appendChild(removeBtn);

      const handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.innerHTML = '<i class="mdi mdi-drag"></i>';
      handle.addEventListener('pointerdown', (event) => startDrag(event, row, index));
      row.appendChild(handle);

      list.appendChild(row);
    });
  }

  function startDrag(event, row, index) {
    // Without this, iOS/Android still treat the gesture as a potential
    // text-selection/scroll — `touch-action: none` on .drag-handle (see
    // app.css) covers most cases, but Safari in particular needs the pointer
    // event itself suppressed too, or a slow-starting drag still shows the
    // selection-handle/callout UI before the browser catches up.
    event.preventDefault();
    dragFrom = index;
    dragEl = row;
    row.classList.add('dragging');
    row.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (dragFrom === null || !dragEl) return;
    const rows = [...list.children];
    for (const other of rows) {
      if (other === dragEl) continue;
      const rect = other.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      if (event.clientY < rect.top || event.clientY > rect.bottom) continue;
      const otherIndex = Number(other.dataset.index);
      const dragIndex = Number(dragEl.dataset.index);
      if (event.clientY < midpoint && otherIndex < dragIndex) {
        list.insertBefore(dragEl, other);
      } else if (event.clientY >= midpoint && otherIndex > dragIndex) {
        list.insertBefore(dragEl, other.nextSibling);
      }
      [...list.children].forEach((el, i) => (el.dataset.index = String(i)));
    }
  }

  function onPointerUp() {
    if (dragFrom === null || !dragEl) return;
    const to = Number(dragEl.dataset.index);
    dragEl.classList.remove('dragging');
    if (to !== dragFrom) sendCommand('queue-reorder', { from: dragFrom, to });
    dragFrom = null;
    dragEl = null;
  }

  list.addEventListener('pointermove', onPointerMove);
  list.addEventListener('pointerup', onPointerUp);
  list.addEventListener('pointercancel', onPointerUp);

  function render(s) {
    if (dragFrom !== null) return; // don't fight an in-progress drag
    localQueue = s.snapshot.queue || [];
    renderList(localQueue, s.snapshot.queue_index);
  }

  const unsubscribe = subscribe(render);
  render(state);
  return unsubscribe;
}

registerRoute('/queue', renderQueue);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
