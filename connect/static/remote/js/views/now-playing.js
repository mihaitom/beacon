import { sendCommand } from '../api.js';
import { registerRoute } from '../router.js';
import { state, subscribe } from '../state.js';
import { openDevicePicker } from '../devices.js';
import { setArt } from '../art.js';

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function renderNowPlaying(root) {
  root.innerHTML = `
    <div class="now-playing">
      <div class="cover-art" id="np-art"></div>
      <div>
        <div class="track-title" id="np-title">Nothing playing</div>
        <div class="track-artist" id="np-artist"></div>
      </div>
      <div class="seek-row">
        <input type="range" id="np-seek" min="0" max="100" step="1" value="0" />
        <div class="time-row"><span id="np-elapsed">0:00</span><span id="np-duration">0:00</span></div>
      </div>
      <div class="transport-row">
        <button id="np-prev"><i class="mdi mdi-skip-previous"></i></button>
        <button id="np-play" class="play-pause"><i class="mdi mdi-play"></i></button>
        <button id="np-next"><i class="mdi mdi-skip-next"></i></button>
      </div>
      <div class="toggle-row">
        <button id="np-shuffle"><i class="mdi mdi-shuffle"></i></button>
        <button id="np-cast" title="Play on…"><i class="mdi mdi-cast"></i></button>
        <button id="np-repeat"><i class="mdi mdi-repeat"></i></button>
      </div>
      <div class="volume-row">
        <i class="mdi mdi-volume-high"></i>
        <input type="range" id="np-volume" min="0" max="100" step="1" value="100" />
      </div>
    </div>
  `;

  const castBtn = root.querySelector('#np-cast');
  const art = root.querySelector('#np-art');
  const title = root.querySelector('#np-title');
  const artist = root.querySelector('#np-artist');
  const seek = root.querySelector('#np-seek');
  const elapsedLabel = root.querySelector('#np-elapsed');
  const durationLabel = root.querySelector('#np-duration');
  const playBtn = root.querySelector('#np-play');
  const shuffleBtn = root.querySelector('#np-shuffle');
  const repeatBtn = root.querySelector('#np-repeat');
  const volume = root.querySelector('#np-volume');

  let seeking = false;
  let volumeDragging = false;
  // render() fires on every snapshot tick — several times a second while
  // playing (position updates). Re-creating the <img> on every single one
  // of those (see art.js's setArt()) would reload/flicker it for no reason
  // — only touch the DOM when the artwork (or which fallback icon it'd get,
  // e.g. switching from a track to radio while neither has art) changed.
  let lastArtKey;

  function render(s) {
    const snapshot = s.snapshot;
    const track = snapshot.current_track;
    const artUrl = track?.cover_art_url || snapshot.radio?.favicon_url || null;
    const artKey = `${artUrl ?? ''}|${snapshot.radio ? 1 : 0}`;
    if (artKey !== lastArtKey) {
      lastArtKey = artKey;
      setArt(art, artUrl, snapshot.radio ? 'mdi-radio' : null);
    }
    title.textContent = track ? track.title : snapshot.radio ? snapshot.radio.name : 'Nothing playing';
    artist.textContent = track ? track.artist || '' : snapshot.radio ? 'Radio' : '';
    playBtn.innerHTML = snapshot.playing
      ? '<i class="mdi mdi-pause"></i>'
      : '<i class="mdi mdi-play"></i>';
    shuffleBtn.classList.toggle('active', !!snapshot.shuffle);
    repeatBtn.classList.toggle('active', snapshot.repeat !== 'off');
    repeatBtn.innerHTML =
      snapshot.repeat === 'one' ? '<i class="mdi mdi-repeat-once"></i>' : '<i class="mdi mdi-repeat"></i>';

    const casting = snapshot.casting ?? [];
    castBtn.classList.toggle('active', casting.length > 0);
    castBtn.querySelector('i').className = casting.length > 0 ? 'mdi mdi-cast-connected' : 'mdi mdi-cast';
    castBtn.title = casting.length > 0 ? `Playing on ${casting.map((t) => t.name).join(', ')}` : 'Play on…';

    if (!seeking) {
      seek.max = String(Math.max(snapshot.duration || 0, 1));
      seek.value = String(snapshot.position || 0);
      elapsedLabel.textContent = formatTime(snapshot.position || 0);
      durationLabel.textContent = formatTime(snapshot.duration || 0);
    }
    if (!volumeDragging) {
      // Mirrors PlayerBar.vue's own slider swap: exactly one active cast
      // target -> that device's volume (disabled until the first poll
      // resolves, see stores/remoteControl.ts's device_volume field);
      // zero -> local; 2+ -> no single "the" volume to represent here, same
      // as the desktop's own local-fallback slider going disabled then.
      if (casting.length === 1) {
        volume.disabled = snapshot.device_volume == null;
        volume.value = String(snapshot.device_volume ?? 0);
      } else {
        volume.disabled = casting.length > 1;
        volume.value = String(Math.round((snapshot.volume ?? 1) * 100));
      }
    }
  }

  const unsubscribe = subscribe(render);
  render(state);

  castBtn.addEventListener('click', () => void openDevicePicker());
  playBtn.addEventListener('click', () => sendCommand('toggle-play'));
  root.querySelector('#np-prev').addEventListener('click', () => sendCommand('previous'));
  root.querySelector('#np-next').addEventListener('click', () => sendCommand('next'));
  shuffleBtn.addEventListener('click', () => sendCommand('shuffle'));
  repeatBtn.addEventListener('click', () => sendCommand('repeat'));

  seek.addEventListener('input', () => {
    seeking = true;
    elapsedLabel.textContent = formatTime(Number(seek.value));
  });
  seek.addEventListener('change', () => {
    sendCommand('seek', { position: Number(seek.value) });
    seeking = false;
  });

  volume.addEventListener('input', () => {
    volumeDragging = true;
  });
  volume.addEventListener('change', () => {
    sendCommand('volume', { volume: Number(volume.value) / 100 });
    volumeDragging = false;
  });

  return unsubscribe;
}

registerRoute('/now-playing', renderNowPlaying);
