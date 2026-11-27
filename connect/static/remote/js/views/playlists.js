import { sendReportedCommand, fetchPlaylists, fetchPlaylist } from '../api.js';
import { renderSongRow } from '../song-row.js';
import { registerRoute } from '../router.js';
import { renderPlaylistRow } from '../playlist-row.js';
import { t } from '../i18n.js';

/** Whether a playlist is the signed-in account's own — the same rule as
 * the app's isOwnedBy(): the bridges say so outright, a Subsonic server
 * only names an owner. */
function isOwnedBy(playlist, username) {
  return playlist.owned_by_user ?? playlist.owner === username;
}

/** The groups the app's own Playlists page lists, each playlist in exactly
 * one (see services/library/playlistBrowse.ts). */
function sectionsFor(items, username) {
  const sharedByMe = (playlist) => isOwnedBy(playlist, username) && playlist.public;
  const mine = (playlist) => isOwnedBy(playlist, username);
  return [
    {
      key: 'mine',
      title: t('playlists.personal'),
      playlists: items.filter((playlist) => mine(playlist) && !sharedByMe(playlist)),
    },
    {
      key: 'sharedByMe',
      title: t('playlists.sharedByMe'),
      playlists: items.filter(sharedByMe),
    },
    {
      key: 'sharedWithMe',
      title: t('playlists.sharedWithMe'),
      playlists: items.filter((playlist) => !mine(playlist)),
    },
  ].filter((section) => section.playlists.length);
}

export function renderPlaylists(root) {
  root.innerHTML = `
    <h1 class="view-title">${t('playlists.title')}</h1>
    <div class="search-field">
      <input type="search" class="search-input" id="playlist-search" placeholder="${t('search.label')}" />
      <button type="button" class="search-clear hidden" id="playlist-search-clear"
              aria-label="${t('common.clearSearch')}"><i class="mdi mdi-close"></i></button>
    </div>
    <div id="playlist-list"><div class="empty-state">${t('common.loading')}</div></div>
  `;
  const list = root.querySelector('#playlist-list');
  const searchInput = root.querySelector('#playlist-search');
  const searchClear = root.querySelector('#playlist-search-clear');

  let all = [];
  let username = '';
  let query = '';

  function render() {
    list.innerHTML = '';
    if (!all.length) {
      list.innerHTML = `<div class="empty-state">${t('playlists.empty')}</div>`;
      return;
    }
    const matching = query
      ? all.filter((playlist) => playlist.name.toLowerCase().includes(query.toLowerCase()))
      : all;
    if (!matching.length) {
      list.innerHTML = `<div class="empty-state">${t('playlists.noPlaylistsForQuery', { query })}</div>`;
      return;
    }
    for (const section of sectionsFor(matching, username)) {
      const heading = document.createElement('h2');
      heading.className = 'section-heading';
      heading.textContent = section.title;
      list.appendChild(heading);
      const rows = document.createElement('div');
      rows.className = 'list';
      for (const playlist of section.playlists) {
        rows.appendChild(
          renderPlaylistRow(playlist, {
            showOwner: section.key === 'sharedWithMe',
          }),
        );
      }
      list.appendChild(rows);
    }
  }

  function syncClear() {
    searchClear.classList.toggle('hidden', searchInput.value === '');
  }
  searchInput.addEventListener('input', () => {
    syncClear();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      query = searchInput.value.trim();
      render();
    }, 200);
  });
  searchClear.addEventListener('click', () => {
    clearTimeout(debounceTimer);
    searchInput.value = '';
    syncClear();
    query = '';
    render();
    searchInput.focus();
  });

  fetchPlaylists()
    .then((answer) => {
      all = answer.items ?? [];
      username = answer.username ?? '';
      render();
    })
    .catch(() => {
      list.innerHTML = `<div class="empty-state">${t('playlists.failed')}</div>`;
    });

  return () => clearTimeout(debounceTimer);
}

export function renderPlaylistDetail(root, params) {
  root.innerHTML =
    `<a href="#/playlists" class="back-link"><i class="mdi mdi-chevron-left"></i>${t('playlists.title')}</a>` +
    `<div id="playlist-detail">${t('common.loading')}</div>`;
  const container = root.querySelector('#playlist-detail');

  fetchPlaylist(params.id)
    .then(({ playlist, songs }) => {
      container.innerHTML = '';
      const header = document.createElement('div');
      // The playlist's own name is this view's title, same treatment as
      // every other view's — the last .section-title in the remote, which
      // was a third heading size on top of the two the views used.
      header.innerHTML = `<h1 class="view-title">${escapeHtml(playlist.name)}</h1>`;
      if (playlist.comment) {
        const description = document.createElement('p');
        description.className = 'playlist-description';
        description.textContent = playlist.comment;
        header.appendChild(description);
      }
      const playAllBtn = document.createElement('button');
      playAllBtn.className = 'btn btn-primary play-all';
      const playAllIcon = document.createElement('i');
      playAllIcon.className = 'mdi mdi-play';
      playAllBtn.append(playAllIcon, t('action.playAll'));
      header.appendChild(playAllBtn);
      container.appendChild(header);

      // Acked only once playback has started, which with a speaker takes
      // seconds (COMMAND_TIMEOUT in routes/remote.py): until then the button
      // turns, and a second tap starts nothing.
      let pending = false;
      const play = (payload, busy) => {
        if (pending) return;
        pending = true;
        playAllBtn.disabled = true;
        playAllIcon.className = 'mdi mdi-loading mdi-spin';
        busy?.classList.add('row--busy');
        sendReportedCommand('play-playlist', { playlistId: playlist.id, ...payload })
          .catch(() => {})
          .finally(() => {
            pending = false;
            playAllBtn.disabled = false;
            playAllIcon.className = 'mdi mdi-play';
            busy?.classList.remove('row--busy');
          });
      };
      playAllBtn.addEventListener('click', () => play({}));

      const list = document.createElement('div');
      list.className = 'list';
      songs.forEach((song, index) => {
        const row = renderSongRow(song, { onPlay: () => play({ startIndex: index }, row) });
        list.appendChild(row);
      });
      container.appendChild(list);
    })
    .catch(() => {
      container.innerHTML = `<div class="empty-state">${t('playlist.failed')}</div>`;
    });
}

registerRoute('/playlists', renderPlaylists);
registerRoute('/playlists/:id', renderPlaylistDetail);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
