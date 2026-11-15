import { fetchBackdrop, fetchLyrics, fireCommand } from '../api.js';
import { navigate, registerRoute } from '../router.js';
import { state, subscribe } from '../state.js';
import { openDevicePicker } from '../devices.js';
import { openEqualizer } from '../equalizer.js';
import { setArt } from '../art.js';
import { paintRange } from '../range.js';
import { createWaveform } from '../waveform.js';
import { setFavorite } from '../favorite.js';
import { t } from '../i18n.js';

// How long the slider keeps its own value after a change, ignoring what
// the desktop reports back. Matches VOLUME_SETTLE_MS in the app's own
// services/connect/volumeGuard.ts — the same race, on the other side of
// the wire: a cast device also takes a moment to report a new level.
const VOLUME_SETTLE_MS = 2500;
// The lyrics lookup can take a few seconds at a third-party provider. The
// phone asks again after this rather than sitting on its first answer.
const LYRICS_RETRY_MS = 1200;
const LYRICS_MAX_RETRIES = 15;

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// The live readout is the one time in this UI that runs past an hour - a
// track never does, so its elapsed/duration pair stays m:ss above. Without
// the hour part a long listen read as "76:47". It only appears once there
// is an hour to show, so the usual case keeps the shorter label.
function formatLiveTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  if (h === 0) return formatTime(seconds);
  const m = Math.floor(seconds / 60) % 60;
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function renderNowPlaying(root) {
  root.innerHTML = `
    <div class="now-playing">
      <div class="np-backdrop" id="np-backdrop"></div>
      <div class="np-scrim"></div>
      <div class="np-toolbar" id="np-toolbar">
        <button type="button" class="np-tool hidden" id="np-tool-lyrics"
                title="${t('lyrics.title')}" aria-label="${t('lyrics.title')}">
          <i class="mdi mdi-script-text-outline"></i>
        </button>
        <button type="button" class="np-tool hidden" id="np-tool-artwork"
                title="${t('nowPlaying.hideArtwork')}" aria-label="${t('nowPlaying.hideArtwork')}">
          <i class="mdi mdi-album"></i>
        </button>
        <button type="button" class="np-tool hidden" id="np-tool-background"
                title="${t('nowPlaying.nextBackground')}" aria-label="${t('nowPlaying.nextBackground')}">
          <i class="mdi mdi-wallpaper"></i>
        </button>
        <button type="button" class="np-tool hidden" id="np-tool-equalizer"
                title="${t('equalizer.title')}" aria-label="${t('equalizer.title')}">
          <i class="mdi mdi-tune-vertical"></i>
        </button>
      </div>
      <div class="np-stage">
        <div class="cover-art" id="np-art"></div>
        <div class="np-lyrics hidden" id="np-lyrics-panel">
          <div class="np-lyrics__scroll" id="np-lyrics-scroll"></div>
          <div class="np-lyrics__credits" id="np-lyrics-credits"></div>
          <button type="button" class="np-lyrics__resume hidden" id="np-lyrics-resume"
                  title="${t('lyrics.resumeAutoscroll')}" aria-label="${t('lyrics.resumeAutoscroll')}">
            <i class="mdi mdi-format-vertical-align-center"></i>
          </button>
        </div>
      </div>
      <div class="now-playing__info">
        <div class="now-playing__eyebrow" id="np-eyebrow"></div>
        <div class="song-title" id="np-title">${t('nowPlaying.nothing')}</div>
        <div class="song-artist" id="np-artist"></div>
        <div class="song-album" id="np-album"></div>
        <!-- Out of the flow and mirrored by the padding on the left, so the
             text stays centred - the app's NowPlayingTrackPanels.vue. -->
        <button id="np-favorite" class="now-playing__favorite hidden" aria-label="${t('favorite.add')}">
          <i class="mdi mdi-heart-outline"></i>
        </button>
      </div>
      <div class="transport-row">
        <div class="transport-side">
          <button id="np-autoplay" title="${t('nowPlaying.autoplay')}"><i class="mdi mdi-infinity"></i></button>
          <button id="np-shuffle"><i class="mdi mdi-shuffle"></i></button>
          <button id="np-prev"><i class="mdi mdi-skip-previous"></i></button>
        </div>
        <button id="np-play" class="play-pause"><i class="mdi mdi-play"></i></button>
        <div class="transport-side">
          <button id="np-next"><i class="mdi mdi-skip-next"></i></button>
          <button id="np-repeat"><i class="mdi mdi-repeat"></i></button>
          <button id="np-cast" title="${t('nowPlaying.playOn')}"><i class="mdi mdi-cast"></i></button>
        </div>
      </div>
      <!-- Below the transport buttons, elapsed and total either side of the
           bar - the same order and the same row MobileTransportControls.vue
           has, rather than above them with the times stacked underneath. -->
      <div class="seek-row" id="np-seek-row">
        <span class="seek-time" id="np-elapsed">0:00</span>
        <span class="seek-bar" id="np-seek"></span>
        <span class="seek-time" id="np-duration">0:00</span>
      </div>
      <!-- What a station gets instead: it has no position or length a bar
           could honestly represent. Mirrors the desktop/mobile app's own
           RadioLiveStatus.vue, three states and all. Its own fixed height,
           so buffering starting or ending never shifts the row below. -->
      <div class="live-row hidden" id="np-live-row">
        <div class="live-buffering hidden" id="np-live-buffering"></div>
        <div class="live-readout hidden" id="np-live-readout">
          <span class="live-dot" id="np-live-dot"></span>
          <span class="live-label">${t('nowPlaying.live')}</span>
          <span class="live-sep">·</span>
          <span class="live-time" id="np-live-time">0:00</span>
        </div>
      </div>
      <div class="volume-row">
        <button id="np-mute"><i class="mdi mdi-volume-high"></i></button>
        <input type="range" id="np-volume" min="0" max="100" step="1" value="100" />
      </div>
    </div>
  `;

  const backdropEl = root.querySelector('#np-backdrop');
  const toolbar = root.querySelector('#np-toolbar');
  // The app bar is the shell's, not this view's, so the buttons are moved
  // into it rather than laid out above the artwork - the same place the
  // app's own phone Now Playing puts its toolbar. Removed again on the way
  // out (see the cleanup below), since the bar survives route changes.
  let appBarActions = document.getElementById('app-bar-actions');
  if (!appBarActions) {
    const appBar = document.querySelector('.app-bar');
    if (appBar) {
      appBarActions = document.createElement('span');
      appBarActions.id = 'app-bar-actions';
      appBarActions.className = 'app-bar__actions';
      appBar.appendChild(appBarActions);
    }
  }
  if (appBarActions) {
    // A view left behind by a re-login can have left its own toolbar here.
    appBarActions.innerHTML = '';
    appBarActions.appendChild(toolbar);
  }
  // From the toolbar itself, not the view: it lives in the app bar by now.
  const lyricsBtn = toolbar.querySelector('#np-tool-lyrics');
  const artworkBtn = toolbar.querySelector('#np-tool-artwork');
  const backgroundBtn = toolbar.querySelector('#np-tool-background');
  const equalizerBtn = toolbar.querySelector('#np-tool-equalizer');
  const stageArt = root.querySelector('#np-art');
  const lyricsPanel = root.querySelector('#np-lyrics-panel');
  const lyricsScroll = root.querySelector('#np-lyrics-scroll');
  const lyricsCredits = root.querySelector('#np-lyrics-credits');
  const lyricsResume = root.querySelector('#np-lyrics-resume');
  const castBtn = root.querySelector('#np-cast');
  const eyebrow = root.querySelector('#np-eyebrow');
  const title = root.querySelector('#np-title');
  const artist = root.querySelector('#np-artist');
  const album = root.querySelector('#np-album');
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
  const favoriteBtn = root.querySelector('#np-favorite');
  // The artist's name leads to their page, as on the app's Now Playing;
  // radio and a song without an artist id leave it plain text.
  artist.addEventListener('click', () => {
    const artistId = state.snapshot.current_song?.artist_id;
    if (artistId) navigate(`/artists/${encodeURIComponent(artistId)}`);
  });
  // The album line leads to its page, as on the app's Now Playing.
  album.addEventListener('click', () => {
    const albumId = state.snapshot.current_song?.album_id;
    if (albumId) navigate(`/albums/${encodeURIComponent(albumId)}`);
  });

  favoriteBtn.addEventListener('click', () => {
    const song = state.snapshot.current_song;
    // The next snapshot shows the outcome. A failure raises the banner
    // fireCommand() raises (api.js) - this needs sendCommand's answer.
    if (!song) return;
    setFavorite(song, !song.starred).catch(() => {
      window.dispatchEvent(new CustomEvent('beacon-remote-command-failed'));
    });
  });
  const muteBtn = root.querySelector('#np-mute');
  const volume = root.querySelector('#np-volume');

  // The bar paints its own drag; this only keeps incoming snapshots from
  // fighting the finger, and carries the elapsed label along with it.
  const waveform = createWaveform({
    onPreview: (position) => {
      elapsedLabel.textContent = formatTime(position);
    },
    onSeek: (position) => fireCommand('seek', { position }),
  });
  root.querySelector('#np-seek').appendChild(waveform.element);

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

  // ── Backdrop, artwork and lyrics ──────────────────────────────────────
  let currentSongId = null;
  let lastCoverUrl = null;
  let backdropSource = null;
  let backdropUrls = [];
  let backdropIndex = 0;
  let lastBackdropKey;
  let artworkHidden = false;
  // The artist lookup goes through MusicBrainz, which can outlast the
  // backend's query budget on a cold cache. The renderer keeps working on
  // it, so a later ask finds the answer waiting.
  let backdropRetries = 0;
  let backdropRetryTimer = null;

  let lyricsOpen = false;
  let lyricsPaused = false;
  let lyricsForSongId = null;
  let lyricsState = null;
  let lyricsLoading = false;
  let lyricsRetries = 0;
  let lyricsActiveIndex = -1;
  let lyricElements = [];
  let lyricsRetryTimer = null;

  /** The artist photo once it arrives, the blurred cover until then (or
   * where the artist has none) - the app's own two backdrops. */
  function applyBackdrop(coverUrl) {
    const url = backdropSource || coverUrl;
    const fallback = !backdropSource;
    const key = `${url ?? ''}|${fallback ? 1 : 0}`;
    if (key === lastBackdropKey) return;
    lastBackdropKey = key;
    setArt(backdropEl, url, null);
    backdropEl.classList.toggle('np-backdrop--fallback', fallback);
  }

  function loadBackdrop(songId) {
    clearTimeout(backdropRetryTimer);
    fetchBackdrop(songId)
      .then((answer) => {
        if (currentSongId !== songId) return;
        backdropRetries = 0;
        backdropSource = answer?.source ?? null;
        backdropUrls = Array.isArray(answer?.backgrounds) ? answer.backgrounds : [];
        backdropIndex = Math.max(0, backdropUrls.indexOf(backdropSource));
        lastBackdropKey = undefined;
        applyBackdrop(lastCoverUrl);
        updateToolbar(state.snapshot);
      })
      .catch(() => {
        // The cover stays the backdrop while the renderer finishes the
        // lookup; ask once more after a moment.
        if (currentSongId !== songId || backdropRetries >= 2) return;
        backdropRetries += 1;
        backdropRetryTimer = setTimeout(() => {
          if (currentSongId === songId) loadBackdrop(songId);
        }, 3000);
      });
  }

  function setArtworkVisible() {
    stageArt.classList.toggle('hidden', lyricsOpen || artworkHidden);
  }

  function setLyricsOpen(open) {
    lyricsOpen = open;
    lyricsPanel.classList.toggle('hidden', !lyricsOpen);
    setArtworkVisible();
    lyricsBtn.classList.toggle('active', lyricsOpen);
    if (!lyricsOpen) {
      lyricsPaused = false;
      lyricsResume.classList.add('hidden');
      return;
    }
    const songId = state.snapshot.current_song?.id ?? null;
    if (!songId) return;
    if (!lyricsState && !lyricsLoading) loadLyrics(songId);
    else {
      renderLyrics();
      updateLyricsPosition(state.snapshot, true);
    }
  }

  function resetLyrics(songId) {
    clearTimeout(lyricsRetryTimer);
    lyricsRetryTimer = null;
    lyricsForSongId = songId;
    lyricsState = null;
    lyricsLoading = false;
    lyricsRetries = 0;
    lyricsPaused = false;
    lyricsActiveIndex = -1;
    lyricElements = [];
    lyricsScroll.innerHTML = '';
    lyricsCredits.textContent = '';
    lyricsScroll.scrollTop = 0;
    lyricsResume.classList.add('hidden');
  }

  function loadLyrics(songId) {
    if (lyricsForSongId !== songId) return;
    lyricsLoading = true;
    lyricsState = null;
    lyricsActiveIndex = -1;
    lyricElements = [];
    renderLyrics();
    fetchLyrics(songId)
      .then((answer) => {
        if (lyricsForSongId !== songId) return;
        lyricsState = answer;
        lyricsLoading = false;
        renderLyrics();
        updateLyricsPosition(state.snapshot, true);
        if (answer?.loading && lyricsRetries < LYRICS_MAX_RETRIES) {
          lyricsRetries += 1;
          lyricsRetryTimer = setTimeout(() => {
            if (lyricsOpen && lyricsForSongId === songId) loadLyrics(songId);
          }, LYRICS_RETRY_MS);
        } else {
          lyricsRetries = 0;
        }
      })
      .catch(() => {
        if (lyricsForSongId !== songId) return;
        lyricsLoading = false;
        lyricsState = { error: true, lines: [], synced: false };
        renderLyrics();
      });
  }

  function renderLyrics() {
    lyricsScroll.innerHTML = '';
    lyricElements = [];
    if (!lyricsOpen) return;
    lyricsCredits.textContent = '';

    const status = (text) => {
      const div = document.createElement('div');
      div.className = 'np-lyrics__status';
      div.textContent = text;
      lyricsScroll.appendChild(div);
    };

    if (lyricsLoading || lyricsState?.loading) {
      status(t('common.loading'));
      return;
    }
    if (lyricsState?.error) {
      status(t('lyrics.failed'));
      return;
    }
    const lines = lyricsState?.lines ?? [];
    if (!lines.length) {
      status(t('lyrics.none'));
      return;
    }

    if (!lyricsState.synced) {
      const plain = document.createElement('div');
      plain.className = 'np-lyrics__plain';
      plain.textContent = lines.map((line) => line.text).join('\n');
      lyricsScroll.appendChild(plain);
    } else {
      const pad = document.createElement('div');
      pad.className = 'np-lyrics__pad';
      lyricsScroll.appendChild(pad);
      lines.forEach((line) => {
        const element = document.createElement('div');
        element.className = 'np-lyric';
        element.textContent = line.text || '♪';
        element.addEventListener('click', () => {
          lyricsPaused = false;
          lyricsResume.classList.add('hidden');
          fireCommand('seek', { position: line.time + (lyricsState.offset ?? 0) });
        });
        lyricsScroll.appendChild(element);
        lyricElements.push(element);
      });
      const endPad = document.createElement('div');
      endPad.className = 'np-lyrics__pad';
      lyricsScroll.appendChild(endPad);
    }

    lyricsCredits.textContent = (lyricsState.credits ?? []).filter(Boolean).join(' · ');
    lyricsActiveIndex = -1;
    updateLyricsPosition(state.snapshot, true);
  }

  function activeLyricIndex(position, offset) {
    let index = -1;
    for (let i = 0; i < lyricElements.length; i++) {
      if ((lyricsState.lines[i]?.time ?? 0) > position - offset) break;
      index = i;
    }
    return index;
  }

  function scrollToActiveLyric() {
    const element = lyricElements[lyricsActiveIndex];
    if (!element) return;
    const top = element.offsetTop - lyricsScroll.clientHeight / 2 + element.clientHeight / 2;
    lyricsScroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function updateLyricsPosition(snapshot, force = false) {
    if (!lyricsOpen || !lyricsState?.synced || !lyricElements.length) return;
    const index = activeLyricIndex(snapshot.position || 0, lyricsState.offset ?? 0);
    if (!force && index === lyricsActiveIndex) return;
    lyricsActiveIndex = index;
    lyricElements.forEach((element, at) => {
      element.classList.toggle('np-lyric--active', at === index);
      element.classList.toggle('np-lyric--past', at < index);
    });
    if (!lyricsPaused) scrollToActiveLyric();
  }

  function onSongChanged(songId, isRadio) {
    currentSongId = songId;
    clearTimeout(backdropRetryTimer);
    backdropRetries = 0;
    backdropSource = null;
    backdropUrls = [];
    backdropIndex = 0;
    lastBackdropKey = undefined;
    artworkHidden = false;
    resetLyrics(songId);
    if (!songId || isRadio) {
      if (lyricsOpen) setLyricsOpen(false);
      return;
    }
    loadBackdrop(songId);
    if (lyricsOpen) loadLyrics(songId);
  }

  function updateToolbar(snapshot) {
    const hasSong = Boolean(snapshot.current_song);
    if (!backdropSource) artworkHidden = false;
    lyricsBtn.classList.toggle('hidden', !hasSong);
    lyricsBtn.classList.toggle('active', lyricsOpen);
    artworkBtn.classList.toggle('hidden', !backdropSource);
    artworkBtn.classList.toggle('active', artworkHidden && Boolean(backdropSource));
    const artworkLabel = t(artworkHidden ? 'nowPlaying.showArtwork' : 'nowPlaying.hideArtwork');
    artworkBtn.title = artworkLabel;
    artworkBtn.setAttribute('aria-label', artworkLabel);
    backgroundBtn.classList.toggle('hidden', backdropUrls.length < 2);
    equalizerBtn.classList.toggle('hidden', !(snapshot.casting?.length));
    setArtworkVisible();
  }

  lyricsBtn.addEventListener('click', () => setLyricsOpen(!lyricsOpen));
  artworkBtn.addEventListener('click', () => {
    if (!backdropSource) return;
    artworkHidden = !artworkHidden;
    updateToolbar(state.snapshot);
  });
  backgroundBtn.addEventListener('click', () => {
    if (backdropUrls.length < 2) return;
    backdropIndex = (backdropIndex + 1) % backdropUrls.length;
    backdropSource = backdropUrls[backdropIndex] ?? null;
    lastBackdropKey = undefined;
    applyBackdrop(lastCoverUrl);
  });
  equalizerBtn.addEventListener('click', () => openEqualizer());
  lyricsResume.addEventListener('click', () => {
    lyricsPaused = false;
    lyricsResume.classList.add('hidden');
    lyricsActiveIndex = -1;
    updateLyricsPosition(state.snapshot, true);
  });
  // Scrolling by hand hands the list to the reader: it stays where it was
  // put until the resume button above hands it back.
  const pauseLyrics = () => {
    if (!lyricsOpen || lyricsPaused) return;
    lyricsPaused = true;
    lyricsResume.classList.remove('hidden');
  };
  lyricsScroll.addEventListener('wheel', pauseLyrics, { passive: true });
  lyricsScroll.addEventListener('touchmove', pauseLyrics, { passive: true });

  function render(s) {
    const snapshot = s.snapshot;
    const song = snapshot.current_song;
    const radio = snapshot.radio;
    const songId = song?.id ?? null;
    if (songId !== currentSongId) onSongChanged(songId, Boolean(radio));

    const artUrl = song?.cover_art_url || snapshot.radio?.favicon_url || null;
    lastCoverUrl = artUrl;
    const artKey = `${artUrl ?? ''}|${snapshot.radio ? 1 : 0}`;
    if (artKey !== lastArtKey) {
      lastArtKey = artKey;
      setArt(stageArt, artUrl, snapshot.radio ? 'mdi-radio' : null);
    }
    applyBackdrop(artUrl);
    updateToolbar(snapshot);
    // Same "Now playing"/"Pause" distinction as NowPlayingView.vue's own
    // eyebrow computed (home.nowPlaying/home.paused) — empty once there's
    // nothing loaded at all, matching the title's own "Nothing playing".
    eyebrow.textContent =
      song || snapshot.radio ? t(snapshot.playing ? 'nowPlaying.playing' : 'nowPlaying.paused') : '';
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
        : t('nowPlaying.nothing');
    artist.textContent = song ? song.artist || '' : nowPlaying ? snapshot.radio.name : '';
    artist.classList.toggle('song-artist--link', !!song?.artist_id);
    album.textContent = song?.album || '';
    album.classList.toggle('song-album--link', !!song?.album_id);
    favoriteBtn.classList.toggle('hidden', !song || !snapshot.favorites_supported);
    favoriteBtn.classList.toggle('active', !!song?.starred);
    favoriteBtn.querySelector('i').className = song?.starred ? 'mdi mdi-heart' : 'mdi mdi-heart-outline';
    favoriteBtn.setAttribute('aria-label', t(song?.starred ? 'favorite.remove' : 'favorite.add'));
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
    //
    // On a station it is disabled instead, like the queue buttons above:
    // autoplay tops the queue up as it runs out and a live stream never
    // does, so it stays visible (the setting is unchanged) but cannot look
    // lit up for something it has no effect on.
    autoplayBtn.classList.toggle('hidden', !snapshot.song_radio_supported);
    autoplayBtn.disabled = isRadio;
    autoplayBtn.classList.toggle('active', !isRadio && !!snapshot.autoplay);

    const casting = snapshot.casting ?? [];
    castBtn.classList.toggle('active', casting.length > 0);
    castBtn.querySelector('i').className = casting.length > 0 ? 'mdi mdi-cast-connected' : 'mdi mdi-cast';
    castBtn.title =
      casting.length > 0
        ? t('nowPlaying.playingOn', { names: casting.map((target) => target.name).join(', ') })
        : t('nowPlaying.playOn');

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
      liveTime.textContent = formatLiveTime(position);
      void waveform.load(null, snapshot.session_id);
    } else {
      // Peaks are keyed on the track, so this is a no-op on every snapshot
      // but the first of a new one.
      void waveform.load(song?.id ?? null, snapshot.session_id);
      waveform.setDisabled(!song);
      if (!waveform.dragging) {
        waveform.setProgress(snapshot.position || 0, snapshot.duration || 0);
        elapsedLabel.textContent = formatTime(snapshot.position || 0);
      }
      durationLabel.textContent = formatTime(snapshot.duration || 0);
    }
    updateLyricsPosition(snapshot);
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

  return () => {
    unsubscribe();
    waveform.destroy();
    // Stops an answer still on its way (and its retry) from landing on a
    // view that is no longer on screen.
    currentSongId = null;
    lyricsForSongId = null;
    clearTimeout(lyricsRetryTimer);
    clearTimeout(backdropRetryTimer);
    toolbar.remove();
  };
}

registerRoute('/now-playing', renderNowPlaying);
