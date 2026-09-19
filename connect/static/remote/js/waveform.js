// waveform.js — the canvas seek bar on Now Playing, the phone's counterpart
// to the app's own SongWaveform.vue. Same peaks (connect decodes them once
// per track, see core/waveform.py) drawn the same way, so the two screens
// show the same shape for the same song.
//
// What it deliberately does *not* have is the app's loading strip along the
// bottom edge: that describes how far a local audio element has buffered,
// and nothing here is playing the audio — the desktop or a speaker is. A
// strip with nothing behind it would be a line that never moves.

import { fetchWaveform } from './api.js';

// Straight from SongWaveform.vue, so a track looks the same on both.
const PLAYED_COLOR = 'rgba(245, 169, 78, 0.85)';
const UNPLAYED_COLOR = 'rgba(255, 255, 255, 0.22)';
const MARKER_COLOR = 'rgba(255, 255, 255, 0.9)';

/** The seek bar as one object: an element to place, and the handful of
 * setters a render() calls on every snapshot.
 *
 * `onPreview` fires all through a drag (the caller shows the time under the
 * finger), `onSeek` once when it ends — one command per drag rather than
 * one per pointer event, the same split SongWaveform.vue makes and for the
 * same reason: a seek round-trips to whatever is actually playing. */
export function createWaveform({ onPreview, onSeek }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'waveform';

  let peaks = [];
  let position = 0;
  let duration = 0;
  let disabled = false;
  let dragging = false;
  // Which track's peaks are loaded or on their way, so the snapshots
  // arriving several times a second don't re-request the same ones.
  let loadedId = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    paint();
  }

  function paint() {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    if (!ctx || width <= 0 || height <= 0) return;
    ctx.clearRect(0, 0, width, height);

    // Clamped, so a position that lands a hair past duration (rounding,
    // mostly) reads as fully played instead of drawing off the edge.
    const playedX = duration > 0 ? Math.min(width, (position / duration) * width) : 0;

    if (peaks.length === 0) {
      // A real track whose peaks have not arrived yet - a flat line in the
      // same two colours, so the bar still reads as a seek bar rather than
      // as empty space. Radio never gets here; it swaps the whole row out.
      const y = height / 2 - 1;
      ctx.fillStyle = UNPLAYED_COLOR;
      ctx.fillRect(0, y, width, 2);
      ctx.fillStyle = PLAYED_COLOR;
      ctx.fillRect(0, y, playedX, 2);
    } else {
      const barWidth = width / peaks.length;
      const gap = barWidth > 3 ? 1 : 0;
      for (let i = 0; i < peaks.length; i++) {
        const x = i * barWidth;
        // Only the upper half: the bars grow up from the bottom edge
        // rather than mirroring around a centre line.
        const barHeight = Math.max(1, peaks[i] * height * 0.9);
        ctx.fillStyle = x < playedX ? PLAYED_COLOR : UNPLAYED_COLOR;
        ctx.fillRect(x, height - barHeight, Math.max(0.5, barWidth - gap), barHeight);
      }
    }

    ctx.fillStyle = MARKER_COLOR;
    ctx.fillRect(Math.min(width - 1.5, playedX), 0, 1.5, height);
  }

  function positionFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    return Math.min(duration, Math.max(0, ratio * duration));
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (disabled || duration <= 0) return;
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    position = positionFromEvent(event);
    onPreview?.(position);
    paint();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    position = positionFromEvent(event);
    onPreview?.(position);
    paint();
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!dragging) return;
    dragging = false;
    onSeek?.(positionFromEvent(event));
  });

  // The element has no intrinsic width of its own to observe before it is
  // in the document, so this only ever fires once it has been placed.
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  return {
    element: canvas,
    /** Whether a drag is in progress - the caller stops applying incoming
     * positions while it is, the same guard the old slider needed. */
    get dragging() {
      return dragging;
    },
    setDisabled(next) {
      disabled = next;
      canvas.classList.toggle('waveform--disabled', next);
    },
    /** Position and length from the snapshot. Ignored mid-drag, which is
     * the caller's job to check, not this one's - it still needs to be
     * able to paint the position the finger is at. */
    setProgress(nextPosition, nextDuration) {
      position = nextPosition;
      duration = nextDuration;
      paint();
    },
    /** Peaks for whichever track is playing, fetched once each. A null id
     * (radio, or nothing loaded) clears them rather than leaving the
     * previous track's shape under a new one. */
    async load(songId, sessionId) {
      if (songId === loadedId) return;
      loadedId = songId;
      peaks = [];
      paint();
      if (!songId) return;
      try {
        const result = await fetchWaveform(songId, sessionId);
        // The track can change while this is in flight; the previous one's
        // shape under the new one's name would be worse than none.
        if (loadedId !== songId) return;
        peaks = result.peaks ?? [];
      } catch {
        // Leaves the flat line above, which is still a usable seek bar.
        // Not retried: unlike the app's own copy, this screen gets a fresh
        // snapshot several times a second and the next track change asks
        // again anyway.
      }
      paint();
    },
    destroy() {
      observer.disconnect();
    },
  };
}
