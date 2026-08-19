import { sendCommand } from '../api.js';
import { registerRoute } from '../router.js';
import { state, subscribe } from '../state.js';
import { openDevicePicker } from '../devices.js';
import { setArt } from '../art.js';
import { paintRange } from '../range.js';

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
        <div class="now-playing__eyebrow" id="np-eyebrow"></div>
        <div class="song-title" id="np-title">Nothing playing</div>
        <div class="song-artist" id="np-artist"></div>
      </div>
      <div class="seek-row">
        <input type="range" id="np-seek" min="0" max="100" step="1" value="0" />
        <div class="time-row"><span id="np-elapsed">0:00</span><span id="np-duration">0:00</span></div>
      </div>
      <div class="transport-row">
        <button id="np-shuffle"><i class="mdi mdi-shuffle"></i></button>
        <button id="np-prev"><i class="mdi mdi-skip-previous"></i></button>
        <button id="np-play" class="play-pause"><i class="mdi mdi-play"></i></button>
        <button id="np-next"><i class="mdi mdi-skip-next"></i></button>
        <button id="np-repeat"><i class="mdi mdi-repeat"></i></button>
      </div>
      <div class="volume-row">
        <button id="np-cast" title="Play on…"><i class="mdi mdi-cast"></i></button>
        <button id="np-mute"><i class="mdi mdi-volume-high"></i></button>
        <input type="range" id="np-volume" min="0" max="100" step="1" value="100" />
      </div>
    </div>
  `;

  const castBtn = root.querySelector('#np-cast');
  const art = root.querySelector('#np-art');
  const eyebrow = root.querySelector('#np-eyebrow');
  const title = root.querySelector('#np-title');
  const artist = root.querySelector('#np-artist');
  const seek = root.querySelector('#np-seek');
  const elapsedLabel = root.querySelector('#np-elapsed');
  const durationLabel = root.querySelector('#np-duration');
  const playBtn = root.querySelector('#np-play');
  const shuffleBtn = root.querySelector('#np-shuffle');
  const repeatBtn = root.querySelector('#np-repeat');
  const muteBtn = root.querySelector('#np-mute');
  const volume = root.querySelector('#np-volume');

  let seeking = false;
  let volumeDragging = false;
  // What to restore to on un-mute — same idea as
  // MobileTransportControls.vue's own volumeBeforeMute.
  let volumeBeforeMute = 100;
  // render() fires on every snapshot tick — several times a second while
  // playing (position updates). Re-creating the <img> on every single one
  // of those (see art.js's setArt()) would reload/flicker it for no reason
  // — only touch the DOM when the artwork (or which fallback icon it'd get,
  // e.g. switching from a song to radio while neither has art) changed.
  let lastArtKey;

  function render(s) {
    const snapshot = s.snapshot;
    const song = snapshot.current_song;
    const artUrl = song?.cover_art_url || snapshot.radio?.favicon_url || null;
    const artKey = `${artUrl ?? ''}|${snapshot.radio ? 1 : 0}`;
    if (artKey !== lastArtKey) {
      lastArtKey = artKey;
      setArt(art, artUrl, snapshot.radio ? 'mdi-radio' : null);
    }
    // Same "Now playing"/"Pause" distinction as NowPlayingView.vue's own
    // eyebrow computed (home.nowPlaying/home.paused) — empty once there's
    // nothing loaded at all, matching the title's own "Nothing playing".
    eyebrow.textContent = song || snapshot.radio ? (snapshot.playing ? 'Now playing' : 'Pause') : '';
    title.textContent = song ? song.title : snapshot.radio ? snapshot.radio.name : 'Nothing playing';
    artist.textContent = song ? song.artist || '' : snapshot.radio ? 'Radio' : '';
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
      paintRange(seek);
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
      // Matches MobileTransportControls.vue's own volumeIcon computed.
      muteBtn.querySelector('i').className =
        Number(volume.value) === 0 ? 'mdi mdi-volume-mute' : 'mdi mdi-volume-high';
      paintRange(volume);
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
    paintRange(seek);
  });
  seek.addEventListener('change', () => {
    sendCommand('seek', { position: Number(seek.value) });
    seeking = false;
  });

  volume.addEventListener('input', () => {
    volumeDragging = true;
    paintRange(volume);
  });
  volume.addEventListener('change', () => {
    sendCommand('volume', { volume: Number(volume.value) / 100 });
    volumeDragging = false;
  });

  muteBtn.addEventListener('click', () => {
    if (volume.disabled) return;
    const current = Number(volume.value);
    const next = current === 0 ? volumeBeforeMute || 100 : 0;
    if (current !== 0) volumeBeforeMute = current;
    volume.value = String(next);
    paintRange(volume);
    sendCommand('volume', { volume: next / 100 });
  });

  return unsubscribe;
}

registerRoute('/now-playing', renderNowPlaying);
