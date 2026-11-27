// section-scrubber.js — the library's way through a long list by section:
// the app's MobileSectionScrubber.vue, the desktop letter bar made for a
// thumb. Out of the way until the list moves; scrolling brings out a grip
// on the right edge (the Android/Contacts fast-scroll pattern). Dragging
// the grip opens the rail and scrubs section by section; a tap opens it to
// pick from.

import { t } from './i18n.js';

/** A thumb's width, a little taller than wide so it reads as something to
 * pull rather than a button. */
const GRIP_HEIGHT = 52;
/** How long the grip stays after the list stops moving. */
const LINGER_MS = 1500;
/** Under this much travel a press is a tap, not a drag. */
const TAP_SLOP_PX = 8;
/** Clear of the bars and of each end of the list. */
const EDGE_GAP = 12;

/**
 * `scroller` is what scrolls (#view-root); `topInset()` how much of its top
 * the sticky controls cover. `onSelect(key)` jumps the list to a section.
 * The list tells it where it is through setActive() and setProgress().
 */
export function createSectionScrubber({ scroller, topInset, onSelect }) {
  const el = document.createElement('div');
  el.className = 'scrubber';
  el.innerHTML = `
    <div class="scrubber__scrim hidden"></div>
    <div class="scrubber__rail" aria-hidden="true"></div>
    <div class="scrubber__bubble hidden" aria-hidden="true"></div>
    <button type="button" class="scrubber__grip" aria-label="${t('library.jumpToSection')}"
            aria-expanded="false"></button>
  `;
  document.body.appendChild(el);
  const scrim = el.querySelector('.scrubber__scrim');
  const rail = el.querySelector('.scrubber__rail');
  const bubble = el.querySelector('.scrubber__bubble');
  const grip = el.querySelector('.scrubber__grip');

  let sections = [];
  let active = null;
  let picked = null;
  let progress = 0;
  let moving = false;
  let scrubbing = false;
  let open = false;
  let dragTop = null;
  let pressY = 0;
  let travelled = 0;
  let railTop = 0;
  let railHeight = GRIP_HEIGHT;
  let lingerTimer = null;

  function measure() {
    const box = scroller.getBoundingClientRect();
    railTop = box.top + topInset() + EDGE_GAP;
    railHeight = Math.max(GRIP_HEIGHT, box.bottom - EDGE_GAP - railTop);
    el.style.setProperty('--rail-top', `${railTop}px`);
    el.style.setProperty('--rail-height', `${railHeight}px`);
  }

  function current() {
    return scrubbing || open ? (picked ?? active) : active;
  }

  function labelOf(key) {
    return sections.find((section) => section.key === key)?.short ?? key;
  }

  function gripTop() {
    const travel = railHeight - GRIP_HEIGHT;
    if (dragTop !== null) return railTop + Math.min(Math.max(dragTop - GRIP_HEIGHT / 2, 0), travel);
    return railTop + progress * travel;
  }

  function render() {
    el.classList.toggle('scrubber--shown', moving || scrubbing || open);
    el.classList.toggle('scrubber--open', open);
    scrim.classList.toggle('hidden', !open);
    rail.setAttribute('aria-hidden', String(!open));
    grip.setAttribute('aria-expanded', String(open));
    const top = gripTop();
    grip.style.top = `${top}px`;
    const here = current();
    grip.innerHTML = here
      ? `<span class="scrubber__grip-label"></span>`
      : '<i class="mdi mdi-unfold-more-horizontal"></i>';
    if (here) grip.firstElementChild.textContent = labelOf(here);
    bubble.classList.toggle('hidden', !(scrubbing && here));
    if (scrubbing && here) {
      bubble.textContent = labelOf(here);
      bubble.style.top = `${top + GRIP_HEIGHT / 2}px`;
    }
    for (const button of rail.children) {
      button.classList.toggle('scrubber__section--here', button.dataset.key === here);
      button.tabIndex = open && !button.disabled ? 0 : -1;
    }
  }

  function renderRail() {
    rail.innerHTML = '';
    for (const section of sections) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scrubber__section';
      button.dataset.key = section.key;
      button.textContent = section.short;
      button.disabled = !section.available;
      button.classList.toggle('scrubber__section--off', !section.available);
      button.addEventListener('click', () => pick(section.key));
      rail.appendChild(button);
    }
  }

  function linger() {
    clearTimeout(lingerTimer);
    lingerTimer = setTimeout(() => {
      moving = false;
      render();
    }, LINGER_MS);
  }

  function onScroll() {
    // A jump the scrubber made itself scrolls too; that is no reason to
    // bring the grip out again once it has been put away.
    if (scrubbing || open || scroller.scrollTop <= 0 || !sections.length) return;
    // The bars can have settled since (the mini player comes and goes);
    // read them again each time the grip comes out.
    if (!moving) measure();
    moving = true;
    linger();
    render();
  }

  function nearestAvailable(at) {
    for (let step = 0; step < sections.length; step++) {
      for (const index of [at + step, at - step]) {
        if (sections[index]?.available) return sections[index].key;
      }
    }
    return null;
  }

  /** The section under the thumb, or the nearest one the list has: a greyed
   * letter is not a place to land, but sliding over it must not stall the
   * scrub either. */
  function scrubTo(clientY) {
    dragTop = clientY - railTop;
    const fraction = Math.min(Math.max(dragTop / railHeight, 0), 0.9999);
    const key = nearestAvailable(Math.floor(fraction * sections.length));
    if (key) pick(key);
  }

  function pick(key) {
    if (key === picked && scrubbing) return;
    picked = key;
    onSelect(key);
    // A tick under the thumb for each section passed, where the phone can
    // (Android; iOS gives the web no haptics).
    if (scrubbing) navigator.vibrate?.(6);
    render();
  }

  function start(event) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearTimeout(lingerTimer);
    scrubbing = true;
    pressY = event.clientY;
    travelled = 0;
    picked = active;
  }

  function onMove(event) {
    if (!scrubbing) return;
    travelled = Math.max(travelled, Math.abs(event.clientY - pressY));
    if (travelled < TAP_SLOP_PX) return;
    open = true;
    scrubTo(event.clientY);
    render();
  }

  function onUp() {
    if (!scrubbing) return;
    const tapped = travelled < TAP_SLOP_PX;
    scrubbing = false;
    dragTop = null;
    // A tap on the grip leaves the rail open to pick from; a drag closes it
    // again where the thumb let go.
    if (tapped) {
      open = !open;
    } else {
      open = false;
      moving = true;
      linger();
    }
    render();
  }

  function close() {
    open = false;
    picked = null;
    moving = true;
    linger();
    render();
  }

  grip.addEventListener('pointerdown', (event) => {
    measure();
    start(event);
    render();
  });
  rail.addEventListener('pointerdown', (event) => {
    if (!open) return;
    start(event);
    scrubTo(event.clientY);
  });
  for (const target of [grip, rail]) {
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }
  scrim.addEventListener('pointerdown', close);
  scroller.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', measure);
  measure();
  render();

  return {
    /** `[{ key, short, available }]`, in the order the list runs. Fewer
     * than two sections is nothing to scrub through. */
    setSections(next) {
      sections = next.length > 1 ? next : [];
      el.classList.toggle('hidden', !sections.length);
      renderRail();
      render();
    },
    setActive(key) {
      if (key === active) return;
      active = key;
      render();
    },
    /** Where the list is, 0 at the top to 1 at the end. */
    setProgress(value) {
      progress = Math.min(1, Math.max(0, value));
      if (!scrubbing) grip.style.top = `${gripTop()}px`;
    },
    destroy() {
      clearTimeout(lingerTimer);
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
      el.remove();
    },
  };
}
