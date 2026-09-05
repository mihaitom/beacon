import { fireCommand } from '../api.js';
import { registerRoute } from '../router.js';
import { state, subscribe } from '../state.js';
import { createArt } from '../art.js';

// Pointer-based drag-to-reorder (works for touch and mouse alike, unlike
// HTML5 drag-and-drop which touch browsers don't fire reliably without a
// dedicated "drag handle" long-press gesture anyway) — a fixed handle icon
// starts the drag, rows swap live as the pointer crosses their midpoint,
// and the final position is sent as one queue-reorder command on release.
//
// Windowed rendering: only the rows currently scrolled into view (plus a
// small overscan buffer) ever exist in the DOM. A queue this small usually
// doesn't matter, but a big self-hosted library can produce queues in the
// tens of thousands of tracks, and unconditionally rendering all of them
// (plus, while dragging, re-walking every one of those rows on every single
// pointermove) is enough to freeze the page outright. The rest of the list
// above/below what's rendered is represented by two spacer elements sized
// to hold its place, so the scrollbar and scroll position behave exactly
// as if every row were really there.
const OVERSCAN = 6;
// Matches .row's CSS (48px art + 6px*2 padding + 1px border, and its own
// 60px min-height) — only used to size the very first render, before
// renderWindow() below measures an actual row and corrects it.
const FALLBACK_ROW_HEIGHT = 61;

export function renderQueue(root) {
  root.innerHTML = '<h1 class="view-title">Queue</h1><div class="list" id="queue-list"></div>';
  const list = root.querySelector('#queue-list');

  const topSpacer = document.createElement('div');
  topSpacer.className = 'list-spacer';
  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'list-spacer';
  list.append(topSpacer, bottomSpacer);

  let localQueue = [];
  let currentIndex = -1;
  let dragFrom = null;
  let dragEl = null;
  let rowHeight = null;
  // Content key for the currently *rendered window* only, not the whole
  // queue — rebuilding is skipped unless something in view actually
  // changed. Snapshot ticks land several times a second while playing, and
  // hashing the full queue on every one of those would just move the O(n)
  // cost from "rendering" to "deciding whether to render", which for a
  // 30k+ item queue is exactly as bad.
  let lastWindowKey = null;
  let scrollFrame = null;

  function computeRange() {
    const height = rowHeight ?? FALLBACK_ROW_HEIGHT;
    const viewportRows = Math.ceil(root.clientHeight / height);
    const firstVisible = Math.floor(root.scrollTop / height);
    const start = Math.max(0, firstVisible - OVERSCAN);
    const end = Math.min(localQueue.length, firstVisible + viewportRows + OVERSCAN);
    return { start, end };
  }

  function buildRow(song, index) {
    const row = document.createElement('div');
    row.className = 'row' + (index === currentIndex ? ' playing' : '');
    row.dataset.index = String(index);

    row.appendChild(createArt(song.cover_art_url, null));

    const main = document.createElement('div');
    main.className = 'row-main';
    main.addEventListener('click', () => fireCommand('queue-jump', { index }));
    main.innerHTML = `<div class="row-title">${escapeHtml(song.title)}</div><div class="row-subtitle">${escapeHtml(song.artist || '')}</div>`;
    row.appendChild(main);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'row-action';
    removeBtn.innerHTML = '<i class="mdi mdi-close"></i>';
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      fireCommand('queue-remove', { index });
    });
    row.appendChild(removeBtn);

    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.innerHTML = '<i class="mdi mdi-drag"></i>';
    handle.addEventListener('pointerdown', (event) => startDrag(event, row, index));
    row.appendChild(handle);

    return row;
  }

  function renderWindow() {
    if (!localQueue.length) {
      topSpacer.style.height = '0';
      bottomSpacer.style.height = '0';
      list.querySelectorAll('.row, .empty-state').forEach((el) => el.remove());
      list.insertBefore(Object.assign(document.createElement('div'), {
        className: 'empty-state',
        textContent: 'Queue is empty',
      }), bottomSpacer);
      lastWindowKey = null;
      return;
    }

    const { start, end } = computeRange();
    const key = `${start}-${end}|${localQueue
      .slice(start, end)
      .map((t) => t.id)
      .join(',')}|${currentIndex}`;
    if (key === lastWindowKey) return;
    lastWindowKey = key;

    list.querySelectorAll('.row, .empty-state').forEach((el) => el.remove());
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) fragment.appendChild(buildRow(localQueue[i], i));
    list.insertBefore(fragment, bottomSpacer);

    topSpacer.style.height = `${start * (rowHeight ?? FALLBACK_ROW_HEIGHT)}px`;
    bottomSpacer.style.height = `${(localQueue.length - end) * (rowHeight ?? FALLBACK_ROW_HEIGHT)}px`;

    // First real paint: measure an actual row instead of trusting the CSS-
    // derived fallback forever (font-size accessibility settings, etc. can
    // all shift it). If the measured height meaningfully disagrees with
    // what we used to pick the range, redo it once with the real number —
    // this still happens before the browser paints, so there's no flicker.
    if (rowHeight === null) {
      const firstRow = list.querySelector('.row');
      if (firstRow) {
        const measured = firstRow.getBoundingClientRect().height;
        if (measured > 0) {
          const previous = rowHeight ?? FALLBACK_ROW_HEIGHT;
          rowHeight = measured;
          if (Math.abs(measured - previous) > 1) {
            lastWindowKey = null;
            renderWindow();
          }
        }
      }
    }
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
    // Only ever compares against other *rows* — the spacers sit at either
    // end of `list.children` too, and dragging past the last/first rendered
    // row should just stop there, not try to hop into a spacer's place.
    const rows = [...list.children].filter((el) => el.classList.contains('row'));
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
      // Absolute queue indices, not DOM position — `rows` is only the
      // window currently on screen, which starts partway through the real
      // queue once you've scrolled at all.
      const { start } = computeRange();
      [...list.children]
        .filter((el) => el.classList.contains('row'))
        .forEach((el, i) => (el.dataset.index = String(start + i)));
    }
  }

  function onPointerUp() {
    if (dragFrom === null || !dragEl) return;
    const to = Number(dragEl.dataset.index);
    dragEl.classList.remove('dragging');
    if (to !== dragFrom) fireCommand('queue-reorder', { from: dragFrom, to });
    dragFrom = null;
    dragEl = null;
    // Deliberately not re-rendering here: the drag already moved the row's
    // real DOM node into place, so the window looks right immediately. The
    // next snapshot (arriving within a fraction of a second either way)
    // carries the server-confirmed order and reconciles it for real through
    // the normal render(s) path — rebuilding right now from the *local*,
    // not-yet-confirmed queue would just snap the row back and then
    // forward again a moment later.
  }

  list.addEventListener('pointermove', onPointerMove);
  list.addEventListener('pointerup', onPointerUp);
  list.addEventListener('pointercancel', onPointerUp);

  // A drag pins the pointer to the handle (setPointerCapture) and the
  // handle itself is touch-action: none, so `root` never actually scrolls
  // while dragFrom is set — no need to guard this against an in-flight drag.
  root.addEventListener('scroll', () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      renderWindow();
    });
  });

  function render(s) {
    if (dragFrom !== null) return; // don't fight an in-progress drag
    localQueue = s.snapshot.queue || [];
    currentIndex = s.snapshot.queue_index;
    renderWindow();
  }

  const unsubscribe = subscribe(render);
  render(state);

  return () => {
    unsubscribe();
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
  };
}

registerRoute('/queue', renderQueue);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
