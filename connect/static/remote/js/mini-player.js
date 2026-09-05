// mini-player.js — the strip above the tab bar showing what's playing, on
// every route except Now Playing itself.
//
// Mirrors the mobile web UI's MobilePlayerBar.vue: same two labels in the
// same order, same tap-anywhere-to-open-Now-Playing, same two buttons. It
// lives in the shell rather than in a view because it has to survive route
// changes (see app.js) — the tab bar next to it works the same way.

import { fireCommand } from './api.js';
import { setArt } from './art.js';
import { navigate } from './router.js';
import { state, subscribe } from './state.js';

/** The route currently showing, normalised the same way router.js does it
 * — read from the hash rather than asked of the router, so this never
 * depends on which of the two hashchange listeners runs first. */
function currentPath() {
  return (location.hash.replace(/^#/, '') || '/now-playing').split('?')[0];
}

export function initMiniPlayer() {
  const bar = document.getElementById('mini-player');
  const art = document.getElementById('mini-art');
  const title = document.getElementById('mini-title');
  const subtitle = document.getElementById('mini-subtitle');
  const prevBtn = document.getElementById('mini-prev');
  const playBtn = document.getElementById('mini-play');
  const nextBtn = document.getElementById('mini-next');

  // render() runs on every snapshot tick — several times a second while
  // playing. Rebuilding the <img> each time would reload and flicker it;
  // same guard, and the same reason, as now-playing.js's own.
  let lastArtKey;

  function render() {
    const snapshot = state.snapshot;
    const song = snapshot.current_song;
    const radio = snapshot.radio;
    // Nothing to show, and never on Now Playing itself — that page is
    // what this is a shortcut to.
    const visible = Boolean(song || radio) && currentPath() !== '/now-playing';
    bar.classList.toggle('hidden', !visible);
    if (!visible) return;

    const artUrl = song?.cover_art_url || radio?.favicon_url || null;
    const artKey = `${artUrl ?? ''}|${radio ? 1 : 0}`;
    if (artKey !== lastArtKey) {
      lastArtKey = artKey;
      setArt(art, artUrl, radio ? 'mdi-radio' : null);
    }

    // The station's ICY tag on top and the station underneath it, the same
    // order and the same fallback chain the app's own bars use (see
    // MobilePlayerBar.vue) — station name alone up top until a tag
    // arrives, rather than repeating it on both lines.
    const nowPlaying = radio?.now_playing || null;
    title.textContent = song ? song.title : nowPlaying || radio.name;
    subtitle.textContent = song ? song.artist || '' : nowPlaying ? radio.name : '';

    playBtn.innerHTML = snapshot.playing
      ? '<i class="mdi mdi-pause"></i>'
      : '<i class="mdi mdi-play"></i>';
    // A live stream has no queue to step through — same gating as the
    // transport row's own (see views/now-playing.js). Play/pause stays.
    prevBtn.disabled = Boolean(radio);
    nextBtn.disabled = Boolean(radio);
  }

  bar.addEventListener('click', () => navigate('/now-playing'));
  // stopPropagation, or the tap would also open Now Playing underneath —
  // MobilePlayerBar.vue's buttons carry @click.stop for the same reason.
  prevBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    fireCommand('previous');
  });
  playBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    fireCommand('toggle-play');
  });
  nextBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    fireCommand('next');
  });

  subscribe(render);
  window.addEventListener('hashchange', render);
  render();
}
