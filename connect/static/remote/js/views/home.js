// home.js — the phone's Home: what is playing, then the same shelves the
// app's own phone Home shows (MobileHomeView.vue) — recently played, most
// played songs, recently added, rediscover and a shuffle through the
// library. Answered by the desktop in one query (see home-request).

import { fetchDiscover, fetchHome, fireCommand } from '../api.js';
import { registerRoute, navigate } from '../router.js';
import { renderAlbumTile } from '../album-tile.js';
import { renderSongRow } from '../song-row.js';
import { setArt } from '../art.js';
import { state, subscribe } from '../state.js';
import { t } from '../i18n.js';

/** A phone Home runs long quickly; the rest of a song list is a tap on its
 * chevron away, and "play all" always plays the whole list. */
const SONG_ROWS = 5;
/** Two columns of three: what fits under the hero on a common phone. */
const RECENT_TILES = 6;

export function renderHome(root) {
  root.innerHTML = `
    <div class="home">
      <section class="home-hero hidden" id="home-hero">
        <div class="home-hero__art" id="home-hero-art"></div>
        <div class="home-hero__text">
          <div class="now-playing__eyebrow" id="home-hero-eyebrow"></div>
          <div class="home-hero__title" id="home-hero-title"></div>
          <div class="home-hero__subtitle" id="home-hero-subtitle"></div>
        </div>
        <button type="button" class="home-hero__play" id="home-hero-play"
                title="${t('home.playAll')}" aria-label="${t('home.playAll')}">
          <i class="mdi mdi-play"></i>
        </button>
      </section>
      <div id="home-sections"><div class="empty-state">${t('common.loading')}</div></div>
    </div>
  `;

  const hero = root.querySelector('#home-hero');
  const heroArt = root.querySelector('#home-hero-art');
  const heroEyebrow = root.querySelector('#home-hero-eyebrow');
  const heroTitle = root.querySelector('#home-hero-title');
  const heroSubtitle = root.querySelector('#home-hero-subtitle');
  const heroPlay = root.querySelector('#home-hero-play');
  const sections = root.querySelector('#home-sections');

  let data = null;
  let loading = false;
  let discoverLoading = false;
  const expanded = { top: false, rediscover: false };
  // What the hero is showing, so its button does the right thing.
  let heroAction = null;
  let lastHeroKey;
  // Whether something is playing decides whether the first recent album is
  // already the hero. Re-render the shelves only when that flips, not on
  // every position tick.
  let lastIdle = null;

  function playingSomething(snapshot) {
    return Boolean(snapshot.current_song || snapshot.radio);
  }

  function renderHero() {
    const snapshot = state.snapshot;
    const song = snapshot.current_song;
    const radio = snapshot.radio;
    const idle = !playingSomething(snapshot);
    if (idle !== lastIdle) {
      lastIdle = idle;
      if (data) renderSections();
    }
    const fallback = !playingSomething(snapshot) ? (data?.recent?.[0] ?? null) : null;

    if (!song && !radio && !fallback) {
      hero.classList.add('hidden');
      return;
    }
    hero.classList.remove('hidden');

    const artUrl = song?.cover_art_url || radio?.favicon_url || fallback?.cover_art_url || null;
    const artKey = `${artUrl ?? ''}|${radio ? 1 : 0}`;
    if (artKey !== lastHeroKey) {
      lastHeroKey = artKey;
      setArt(heroArt, artUrl, radio ? 'mdi-radio' : 'mdi-album');
    }

    if (song) {
      heroEyebrow.textContent = t(snapshot.playing ? 'nowPlaying.playing' : 'nowPlaying.paused');
      heroTitle.textContent = song.title;
      heroSubtitle.textContent = song.artist || '';
      heroAction = { kind: 'toggle' };
    } else if (radio) {
      const nowPlaying = radio.now_playing || null;
      heroEyebrow.textContent = t('home.radioEyebrow');
      heroTitle.textContent = nowPlaying || radio.name;
      heroSubtitle.textContent = nowPlaying ? radio.name : '';
      heroAction = { kind: 'toggle' };
    } else {
      heroEyebrow.textContent = t('home.recentlyPlayed');
      heroTitle.textContent = fallback.name;
      heroSubtitle.textContent = [fallback.artist, fallback.year].filter(Boolean).join(' · ');
      heroAction = { kind: 'album', album: fallback };
    }

    const playing = heroAction.kind === 'toggle' && snapshot.playing;
    heroPlay.querySelector('i').className = playing ? 'mdi mdi-pause' : 'mdi mdi-play';
    const label =
      heroAction.kind === 'album'
        ? t('library.play')
        : t(playing ? 'action.pause' : 'action.play');
    heroPlay.title = label;
    heroPlay.setAttribute('aria-label', label);
  }

  heroArt.addEventListener('click', () => {
    if (heroAction?.kind === 'album') {
      navigate(`/albums/${encodeURIComponent(heroAction.album.id)}`);
    } else if (heroAction?.kind === 'toggle') {
      navigate('/now-playing');
    }
  });
  heroPlay.addEventListener('click', () => {
    if (!heroAction) return;
    if (heroAction.kind === 'toggle') fireCommand('toggle-play');
    else playAlbum(heroAction.album);
  });

  function playAlbum(album) {
    fireCommand('play-album', { albumId: album.id });
  }

  function playAlbums(albums) {
    if (!albums.length) return;
    fireCommand('play-albums', { albumIds: albums.map((album) => album.id) });
  }

  function playSongs(songs, startIndex, pinFirst) {
    if (!songs.length) return;
    fireCommand('play-songs', {
      songIds: songs.map((song) => song.id),
      startIndex,
      pinFirst,
    });
  }

  function heading(title, actions = []) {
    const head = document.createElement('div');
    head.className = 'home-section__head';
    const label = document.createElement('h2');
    label.className = 'section-heading home-section__title';
    label.textContent = title;
    head.appendChild(label);
    for (const action of actions) head.appendChild(action);
    return head;
  }

  function iconButton(icon, title, onClick, { disabled = false } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-action home-section__action';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.disabled = disabled;
    button.innerHTML = `<i class="mdi ${icon}"></i>`;
    button.addEventListener('click', onClick);
    return button;
  }

  function albumGrid(albums) {
    const grid = document.createElement('div');
    grid.className = 'home-grid';
    for (const album of albums) {
      grid.appendChild(renderAlbumTile(album, { onPlay: playAlbum }));
    }
    return grid;
  }

  function albumShelf(albums) {
    const shelf = document.createElement('div');
    shelf.className = 'home-shelf';
    for (const album of albums) {
      shelf.appendChild(renderAlbumTile(album, { shelf: true, onPlay: playAlbum }));
    }
    return shelf;
  }

  function songList(songs, shown, { onToggle, onPlayAll, isExpanded }) {
    const wrapper = document.createElement('div');
    const rows = document.createElement('div');
    rows.className = 'home-rows';
    shown.forEach((song, index) => {
      rows.appendChild(
        renderSongRow(song, {
          onPlay: () => playSongs(songs, index, true),
        }),
      );
    });
    wrapper.appendChild(rows);
    // The toggle rides with the heading; callers add it there.
    const toggle =
      songs.length > SONG_ROWS
        ? iconButton(
            isExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down',
            t(isExpanded ? 'library.showLess' : 'library.showMore'),
            onToggle,
          )
        : null;
    return { wrapper, toggle, playAll: onPlayAll };
  }

  function addSection(title, actions, body) {
    const section = document.createElement('section');
    section.className = 'home-section';
    section.appendChild(heading(title, actions));
    section.appendChild(body);
    sections.appendChild(section);
  }

  function renderSections() {
    sections.innerHTML = '';
    if (!data) return;

    const idle = !playingSomething(state.snapshot);
    const recent = (idle ? data.recent.slice(1) : data.recent).slice(0, RECENT_TILES);
    if (recent.length) {
      addSection(
        t('home.recentlyPlayed'),
        [iconButton('mdi-play-circle-outline', t('home.playAll'), () => playAlbums(recent))],
        albumGrid(recent),
      );
    }

    if (data.top_songs.length) {
      const shown = expanded.top ? data.top_songs : data.top_songs.slice(0, SONG_ROWS);
      const list = songList(data.top_songs, shown, {
        isExpanded: expanded.top,
        onToggle: () => {
          expanded.top = !expanded.top;
          renderSections();
        },
        onPlayAll: () => playSongs(data.top_songs, 0, false),
      });
      const actions = [
        iconButton('mdi-play-circle-outline', t('home.playAll'), list.playAll),
      ];
      if (list.toggle) actions.unshift(list.toggle);
      addSection(t('home.topSongs'), actions, list.wrapper);
    }

    if (data.newest.length) {
      addSection(
        t('home.recentlyAdded'),
        [iconButton('mdi-play-circle-outline', t('home.playAll'), () => playAlbums(data.newest))],
        albumShelf(data.newest),
      );
    }

    if (data.rediscover.length) {
      const shown = expanded.rediscover
        ? data.rediscover
        : data.rediscover.slice(0, SONG_ROWS);
      const list = songList(data.rediscover, shown, {
        isExpanded: expanded.rediscover,
        onToggle: () => {
          expanded.rediscover = !expanded.rediscover;
          renderSections();
        },
        onPlayAll: () => playSongs(data.rediscover, 0, false),
      });
      const actions = [
        iconButton('mdi-play-circle-outline', t('home.playAll'), list.playAll),
      ];
      if (list.toggle) actions.unshift(list.toggle);
      addSection(t('home.rediscover'), actions, list.wrapper);
    }

    if (data.discover.length) {
      addSection(
        t('home.discover'),
        [
          iconButton(
            'mdi-shuffle-variant',
            t('home.reroll'),
            (event) => {
              event.currentTarget.disabled = true;
              void rerollDiscover();
            },
            { disabled: loading || discoverLoading },
          ),
          iconButton('mdi-play-circle-outline', t('home.playAll'), () => playAlbums(data.discover)),
        ],
        albumShelf(data.discover),
      );
    }
  }

  /** A fresh draw for Discover alone: the shelves around it stay as they
   * were, the same way the app's own shuffle under that shelf behaves. */
  async function rerollDiscover() {
    if (discoverLoading) return;
    discoverLoading = true;
    try {
      const answer = await fetchDiscover();
      if (data) {
        data.discover = answer.items ?? [];
        renderSections();
      }
    } catch {
      // The shelf keeps what it had.
    } finally {
      discoverLoading = false;
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    if (!data) sections.innerHTML = `<div class="empty-state">${t('common.loading')}</div>`;
    try {
      data = await fetchHome();
    } catch {
      if (!data) sections.innerHTML = `<div class="empty-state">${t('home.failed')}</div>`;
      return;
    } finally {
      loading = false;
    }
    renderSections();
    renderHero();
  }

  const unsubscribe = subscribe(renderHero);
  renderHero();
  load();

  return unsubscribe;
}

registerRoute('/home', renderHome);
