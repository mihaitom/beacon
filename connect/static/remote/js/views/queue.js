import { fireCommand, sendCommand } from '../api.js';
import { registerRoute } from '../router.js';
import { state, subscribe } from '../state.js';
import { createArt } from '../art.js';
import { openActionSheet } from '../sheet.js';
import { onLongPress } from '../long-press.js';

// Pointer-based drag-to-reorder (works for touch and mouse alike, unlike
// HTML5 drag-and-drop which touch browsers don't fire reliably without a
// dedicated "drag handle" long-press gesture anyway) — a fixed handle icon
// starts the drag, a line marks where the song would land, and the final
// position is sent as one queue-reorder command on release. The rows
// themselves stay put until then: the window below is rebuilt while a drag
// scrolls the list, which a row moved by hand would not survive.
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
// Dragging within this far of the list's top or bottom edge scrolls it,
// faster the closer to the edge - the web app's services/edgeScroll.ts.
const EDGE_SCROLL_ZONE_PX = 64;
const EDGE_SCROLL_MAX_PX_PER_S = 1400;

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
  // dragFrom is the song being moved, overIndex/overHalf which side of
  // which row it would land on; dragY is where the finger last was, since
  // a finger held still at the edge keeps scrolling without moving.
  let dragFrom = null;
  let overIndex = null;
  let overHalf = null;
  let dragY = 0;
  let edgeFrame = 0;
  let edgeLastTick = 0;
  // The handle the drag started on - see startDrag. An event that still
  // bubbles reaches it and window both, hence the WeakSet.
  let dragHandle = null;
  const handledEvents = new WeakSet();
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
    applyDragClasses(row, index);
    row.dataset.index = String(index);

    // See song-row.js: a missing cover gets the app's own placeholder
    // rather than an empty square.
    row.appendChild(createArt(song.cover_art_url, 'mdi-album'));

    const main = document.createElement('div');
    main.className = 'row-main';
    main.addEventListener('click', () => fireCommand('queue-jump', { index }));
    // On the whole row, the way a right click works anywhere on it.
    onLongPress(row, () => openQueueActions(song, index));
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
    handle.addEventListener('pointerdown', (event) => startDrag(event, index));
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

  /** What the desktop queue's context menu offers, minus what the remote
   * has no page for (album, artwork, info). */
  function openQueueActions(song, index) {
    if (dragFrom !== null) return;
    const isCurrent = index === currentIndex;
    openActionSheet(
      [
        {
          label: 'Play',
          icon: 'mdi-play',
          disabled: isCurrent,
          onSelect: () => sendCommand('queue-jump', { index }),
        },
        {
          label: 'Play Next',
          icon: 'mdi-skip-next-outline',
          disabled: isCurrent || index === currentIndex + 1,
          onSelect: () => sendCommand('queue-move', { index, where: 'next' }),
        },
        {
          label: 'Move to End',
          icon: 'mdi-arrow-collapse-down',
          disabled: isCurrent || index === localQueue.length - 1,
          onSelect: () => sendCommand('queue-move', { index, where: 'end' }),
        },
        {
          label: 'Remove from Queue',
          icon: 'mdi-playlist-remove',
          disabled: isCurrent,
          onSelect: () => sendCommand('queue-remove', { index }),
        },
        {
          label: 'Start Song Radio',
          icon: 'mdi-antenna',
          onSelect: () => sendCommand('play-song-radio', { songId: song.id }),
        },
      ],
      { title: song.title },
    );
  }

  function applyDragClasses(row, index) {
    const dragging = index === dragFrom;
    row.classList.toggle('dragging', dragging);
    // Not on the dragged row itself: dropping it next to itself moves nothing.
    const target = !dragging && index === overIndex;
    row.classList.toggle('drop-before', target && overHalf === 'before');
    row.classList.toggle('drop-after', target && overHalf === 'after');
  }

  function paintDragState() {
    for (const row of list.querySelectorAll('.row')) {
      applyDragClasses(row, Number(row.dataset.index));
    }
  }

  function startDrag(event, index) {
    // Without this, iOS/Android still treat the gesture as a potential
    // text-selection/scroll — `touch-action: none` on .drag-handle (see
    // app.css) covers most cases, but Safari in particular needs the pointer
    // event itself suppressed too, or a slow-starting drag still shows the
    // selection-handle/callout UI before the browser catches up.
    event.preventDefault();
    dragFrom = index;
    overIndex = index;
    overHalf = 'before';
    dragY = event.clientY;
    paintDragState();
    // On window rather than the row: the row is rebuilt as the list
    // scrolls, and its listeners and pointer capture would go with it. On
    // the handle as well, since WebKit keeps sending a touch's pointer
    // events to the node it started on even once it is detached - where
    // they no longer bubble to window.
    dragHandle = event.currentTarget;
    for (const target of [window, dragHandle]) {
      target.addEventListener('pointermove', onPointerMove);
      target.addEventListener('pointerup', onPointerUp);
      target.addEventListener('pointercancel', onPointerUp);
    }
    edgeLastTick = performance.now();
    edgeFrame = requestAnimationFrame(edgeScrollTick);
  }

  function trackRowUnder(y) {
    for (const row of list.querySelectorAll('.row')) {
      const rect = row.getBoundingClientRect();
      if (y < rect.top || y > rect.bottom) continue;
      overIndex = Number(row.dataset.index);
      overHalf = y > rect.top + rect.height / 2 ? 'after' : 'before';
      paintDragState();
      return;
    }
  }

  function firstSighting(event) {
    if (handledEvents.has(event)) return false;
    handledEvents.add(event);
    return true;
  }

  function onPointerMove(event) {
    if (dragFrom === null || !firstSighting(event)) return;
    dragY = event.clientY;
    trackRowUnder(dragY);
  }

  function edgeScrollTick(now) {
    const dt = Math.min(now - edgeLastTick, 50) / 1000;
    edgeLastTick = now;
    const rect = root.getBoundingClientRect();
    const intoTop = rect.top + EDGE_SCROLL_ZONE_PX - dragY;
    const intoBottom = dragY - (rect.bottom - EDGE_SCROLL_ZONE_PX);
    const depth = Math.max(intoTop, intoBottom);
    if (depth > 0) {
      // Squared, so the edge of the zone creeps and the very edge races.
      const share = Math.min(depth / EDGE_SCROLL_ZONE_PX, 1) ** 2;
      const step = share * EDGE_SCROLL_MAX_PX_PER_S * dt;
      const before = root.scrollTop;
      root.scrollTop += intoTop > 0 ? -step : step;
      if (root.scrollTop !== before) {
        // Synchronously, not on the next scroll event: the row under the
        // finger has to exist before it can be hit-tested.
        renderWindow();
        trackRowUnder(dragY);
      }
    }
    edgeFrame = requestAnimationFrame(edgeScrollTick);
  }

  function stopDrag() {
    for (const target of [window, dragHandle]) {
      target?.removeEventListener('pointermove', onPointerMove);
      target?.removeEventListener('pointerup', onPointerUp);
      target?.removeEventListener('pointercancel', onPointerUp);
    }
    dragHandle = null;
    cancelAnimationFrame(edgeFrame);
    edgeFrame = 0;
  }

  function onPointerUp(event) {
    if (!firstSighting(event)) return;
    stopDrag();
    if (dragFrom === null) return;
    // Same original-index -> post-removal-index conversion as the web
    // app's MobileQueueView.vue.
    const insertBefore = overHalf === 'after' ? overIndex + 1 : overIndex;
    const to = insertBefore > dragFrom ? insertBefore - 1 : insertBefore;
    const from = dragFrom;
    dragFrom = null;
    overIndex = null;
    overHalf = null;
    if (to !== from) {
      fireCommand('queue-reorder', { from, to });
      // Shown moved right away; the next snapshot (a fraction of a second
      // away) carries the confirmed order and reconciles it through the
      // normal render(s) path.
      localQueue = [...localQueue];
      localQueue.splice(to, 0, ...localQueue.splice(from, 1));
      if (currentIndex === from) currentIndex = to;
      else if (from < currentIndex && to >= currentIndex) currentIndex -= 1;
      else if (from > currentIndex && to <= currentIndex) currentIndex += 1;
    }
    lastWindowKey = null;
    renderWindow();
  }

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
    stopDrag();
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
  };
}

registerRoute('/queue', renderQueue);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
