import { fireCommand } from '../api.js';
import { registerRoute } from '../router.js';
import { state, subscribe } from '../state.js';
import { openDevicePicker } from '../devices.js';
import { setArt } from '../art.js';
import { paintRange } from '../range.js';

// How long the slider keeps its own value after a change, ignoring what
// the desktop reports back. Matches VOLUME_SETTLE_MS in the app's own
// services/connect/volumeGuard.ts — the same race, on the other side of
// the wire: a cast device also takes a moment to report a new level.
const VOLUME_SETTLE_MS = 2500;

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
      <div class="seek-row" id="np-seek-row">
        <input type="range" id="np-seek" min="0" max="100" step="1" value="0" />
        <div class="time-row"><span id="np-elapsed">0:00</span><span id="np-duration">0:00</span></div>
      </div>
      <!-- What a station gets instead: it has no position or length a
           slider could honestly represent. Mirrors the desktop/mobile app's
           own RadioLiveStatus.vue, three states and all. Its own fixed
           height, so buffering starting or ending never shifts the
           transport buttons below. -->
      <div class="live-row hidden" id="np-live-row">
        <div class="live-buffering hidden" id="np-live-buffering"></div>
        <div class="live-readout hidden" id="np-live-readout">
          <span class="live-dot" id="np-live-dot"></span>
          <span class="live-label">Live</span>
          <span class="live-sep">·</span>
          <span class="live-time" id="np-live-time">0:00</span>
        </div>
      </div>
      <div class="transport-row">
        <button id="np-shuffle"><i class="mdi mdi-shuffle"></i></button>
        <button id="np-prev"><i class="mdi mdi-skip-previous"></i></button>
        <button id="np-play" class="play-pause"><i class="mdi mdi-play"></i></button>
        <button id="np-next"><i class="mdi mdi-skip-next"></i></button>
        <button id="np-repeat"><i class="mdi mdi-repeat"></i></button>
      </div>
      <div class="volume-row">
        <button id="np-autoplay" title="Autoplay"><i class="mdi mdi-infinity"></i></button>
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
  const seekRow = root.querySelector('#np-seek-row');
  const liveRow = root.querySelector('#np-live-row');
  const liveBuffering = root.querySelector('#np-live-buffering');
  const liveReadout = root.querySelector('#np-live-readout');
  const liveDot = root.querySelector('#np-live-dot');
  const liveTime = root.querySelector('#np-live-time');
  const elapsedLabel = root.querySelector('#np-elapsed');
  const durationLabel = root.querySelector('#np-duration');
  const playBtn = root.querySelector('#np-play');
  const prevBtn = root.querySelector('#np-prev');
  const nextBtn = root.querySelector('#np-next');
  const shuffleBtn = root.querySelector('#np-shuffle');
  const repeatBtn = root.querySelector('#np-repeat');
  const autoplayBtn = root.querySelector('#np-autoplay');
  const muteBtn = root.querySelector('#np-mute');
  const volume = root.querySelector('#np-volume');

  let seeking = false;
  let volumeDragging = false;
  // Until when an incoming snapshot's volume is ignored. Snapshots keep
  // arriving after the slider is let go (the desktop pushes a debounced
  // one several times a second), and any that was built before the command
  // landed still carries the previous value — applying it snapped the
  // slider back to where the drag started. Reported live 2026-09-04 as the
  // volume slider bouncing back; the desktop's own sliders have the same
  // window for the same reason, see services/connect/volumeGuard.ts.
  let volumeHeldUntil = 0;
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
    // Radio's two labels in the same order the app's own player bar uses
    // (see SongInfo.vue): the ICY tag on top, since that is what is
    // actually playing, and the station below it. With no tag the station
    // name moves up and the second line stays empty, rather than repeating
    // it or showing a bare "Radio".
    const nowPlaying = snapshot.radio?.now_playing || null;
    title.textContent = song
      ? song.title
      : snapshot.radio
        ? nowPlaying || snapshot.radio.name
        : 'Nothing playing';
    artist.textContent = song ? song.artist || '' : nowPlaying ? snapshot.radio.name : '';
    playBtn.innerHTML = snapshot.playing
      ? '<i class="mdi mdi-pause"></i>'
      : '<i class="mdi mdi-play"></i>';
    // Everything that acts on a queue is disabled while a station plays —
    // a live stream has none, so the desktop's own actions return early
    // and these would look pressable while doing nothing. Same set the
    // app's CenterControls.vue/MobileTransportControls.vue disable, and
    // the "active" highlight goes with them: a shuffle left on from the
    // last queue must not look lit up on a station it cannot apply to.
    const isRadio = !!snapshot.radio;
    shuffleBtn.disabled = isRadio;
    repeatBtn.disabled = isRadio;
    prevBtn.disabled = isRadio;
    nextBtn.disabled = isRadio;
    shuffleBtn.classList.toggle('active', !isRadio && !!snapshot.shuffle);
    repeatBtn.classList.toggle('active', !isRadio && snapshot.repeat !== 'off');
    repeatBtn.innerHTML =
      snapshot.repeat === 'one' ? '<i class="mdi mdi-repeat-once"></i>' : '<i class="mdi mdi-repeat"></i>';
    // Hidden entirely rather than just inert when the server can't back it
    // at all (Plex without Sonic Analysis bridged, or no server support) —
    // same capability gate PlayerBar.vue's own button uses
    // (authStore.capabilities.songRadio).
    autoplayBtn.classList.toggle('hidden', !snapshot.song_radio_supported);
    autoplayBtn.classList.toggle('active', !!snapshot.autoplay);

    const casting = snapshot.casting ?? [];
    castBtn.classList.toggle('active', casting.length > 0);
    castBtn.querySelector('i').className = casting.length > 0 ? 'mdi mdi-cast-connected' : 'mdi mdi-cast';
    castBtn.title = casting.length > 0 ? `Playing on ${casting.map((t) => t.name).join(', ')}` : 'Play on…';

    seekRow.classList.toggle('hidden', isRadio);
    liveRow.classList.toggle('hidden', !isRadio);
    if (isRadio) {
      // While buffering the elapsed time is frozen or misleading, so the
      // readout gives way to a bar that just says "working on it". Before
      // the station has played at all — one restored on the desktop and
      // never started — neither half has anything true to say, so the row
      // stays empty rather than announcing a station as on air.
      const buffering = !!snapshot.radio.buffering;
      const position = snapshot.position || 0;
      const started = snapshot.playing || position > 0;
      liveBuffering.classList.toggle('hidden', !buffering);
      liveReadout.classList.toggle('hidden', buffering || !started);
      liveReadout.classList.toggle('live-readout--off-air', !snapshot.playing);
      liveDot.classList.toggle('live-dot--on-air', !!snapshot.playing);
      liveTime.textContent = formatTime(position);
    } else if (!seeking) {
      seek.max = String(Math.max(snapshot.duration || 0, 1));
      seek.value = String(snapshot.position || 0);
      elapsedLabel.textContent = formatTime(snapshot.position || 0);
      durationLabel.textContent = formatTime(snapshot.duration || 0);
      paintRange(seek);
    }
    // The value this snapshot would put on the slider — read before the
    // hold below, so a snapshot that already agrees with what was sent
    // ends the hold early rather than sitting it out.
    const incomingVolume =
      casting.length === 1
        ? snapshot.device_volume
        : Math.round((snapshot.volume ?? 1) * 100);
    if (incomingVolume != null && incomingVolume === Number(volume.value)) volumeHeldUntil = 0;
    if (!volumeDragging && Date.now() >= volumeHeldUntil) {
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
  playBtn.addEventListener('click', () => fireCommand('toggle-play'));
  prevBtn.addEventListener('click', () => fireCommand('previous'));
  nextBtn.addEventListener('click', () => fireCommand('next'));
  shuffleBtn.addEventListener('click', () => fireCommand('shuffle'));
  repeatBtn.addEventListener('click', () => fireCommand('repeat'));
  autoplayBtn.addEventListener('click', () => fireCommand('autoplay'));

  seek.addEventListener('input', () => {
    seeking = true;
    elapsedLabel.textContent = formatTime(Number(seek.value));
    paintRange(seek);
  });
  seek.addEventListener('change', () => {
    fireCommand('seek', { position: Number(seek.value) });
    seeking = false;
  });

  volume.addEventListener('input', () => {
    volumeDragging = true;
    paintRange(volume);
  });
  volume.addEventListener('change', () => {
    fireCommand('volume', { volume: Number(volume.value) / 100 });
    volumeDragging = false;
    volumeHeldUntil = Date.now() + VOLUME_SETTLE_MS;
  });

  muteBtn.addEventListener('click', () => {
    if (volume.disabled) return;
    const current = Number(volume.value);
    const next = current === 0 ? volumeBeforeMute || 100 : 0;
    if (current !== 0) volumeBeforeMute = current;
    volume.value = String(next);
    paintRange(volume);
    fireCommand('volume', { volume: next / 100 });
    volumeHeldUntil = Date.now() + VOLUME_SETTLE_MS;
  });

  return unsubscribe;
}

registerRoute('/now-playing', renderNowPlaying);
