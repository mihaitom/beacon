// The folder source's page, shown by Beacon in a sandboxed frame: no cookies,
// no storage, everything in memory. It browses this app's API and asks Beacon
// to play with postMessage (see Beacon's help page "External source API").
'use strict'

const view = document.getElementById('view')
const searchInput = document.getElementById('search')
const embedded = window.parent !== window

const state = {
  albums: [],
  artists: [],
  albumCache: new Map(),
  sort: 'added',
  query: '',
  nowPlaying: null,
  status: null,
}

// ── Helpers ────────────────────────────────────────────────────────────

const ICONS = {
  play: '<path d="M8 5v14l11-7z"/>',
  next: '<path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z"/>',
  queue: '<path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm16-1v-3h-2v3h-3v2h3v3h2v-3h3v-2z"/>',
}
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`

const esc = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

async function api(path, options) {
  const response = await fetch(`api/${path}`, options)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

function duration(seconds) {
  if (!seconds) return ''
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function longDuration(seconds) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const count = (n) => n.toLocaleString()

// One colour per name for anything without a cover, the same every time.
function tint(text) {
  let hash = 0
  for (const c of String(text)) hash = (hash * 31 + c.charCodeAt(0)) | 0
  const hue = Math.abs(hash) % 360
  return `linear-gradient(135deg, hsl(${hue} 55% 45%), hsl(${(hue + 50) % 360} 60% 26%))`
}

function cover(albumId, hasCover, name) {
  const letter = esc((name || '?').trim().charAt(0).toUpperCase() || '?')
  const image = hasCover ? `<img src="covers/${albumId}" alt="" loading="lazy" />` : ''
  return `<div class="cover" style="background:${tint(name)}">${letter}${image}</div>`
}

function toast(text) {
  const el = document.getElementById('toast')
  el.textContent = text
  el.classList.add('show')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => el.classList.remove('show'), 2400)
}

// ── Talking to Beacon ──────────────────────────────────────────────────

// Beacon answers every beacon.play with beacon.played, in order.
const waiting = []

// Several songs go in one message: sent one by one, an album would start as a
// queue of one song, and Beacon's Autoplay would fill it before the rest came.
const MAX_PER_MESSAGE = 500

function send(items, mode) {
  return new Promise((resolve) => {
    if (!embedded) {
      resolve({ ok: false, error: 'Open this page in Beacon to play' })
      return
    }
    const entry = { resolve }
    waiting.push(entry)
    // Should Beacon never answer, the page must not hang.
    entry.timer = setTimeout(() => {
      const index = waiting.indexOf(entry)
      if (index >= 0) waiting.splice(index, 1)
      resolve({ ok: false, error: 'Beacon did not answer' })
    }, 10000)
    window.parent.postMessage({ type: 'beacon.play', mode, items }, '*')
  })
}

async function playRows(rows, { mode = 'now', label } = {}) {
  if (!rows.length) return
  for (let start = 0; start < rows.length; start += MAX_PER_MESSAGE) {
    const items = rows.slice(start, start + MAX_PER_MESSAGE).map((row) => row.item)
    const result = await send(items, start === 0 ? mode : 'queue')
    if (!result.ok) {
      toast(result.error || 'Could not play that')
      return
    }
  }
  if (label) toast(label)
}

async function albumRows(albumId) {
  if (!state.albumCache.has(albumId)) {
    state.albumCache.set(albumId, await api(`albums/${albumId}`))
  }
  return state.albumCache.get(albumId)
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  const message = event.data || {}
  if (message.type === 'beacon.played') {
    const entry = waiting.shift()
    if (entry) {
      clearTimeout(entry.timer)
      entry.resolve(message)
    }
  } else if (message.type === 'beacon.nowPlaying') {
    state.nowPlaying = message.item
    markPlaying()
  } else if (message.type === 'beacon.theme') {
    const c = message.colors || {}
    const style = document.documentElement.style
    const set = (name, value) => value && style.setProperty(name, value)
    set('--bg', c.background)
    set('--fg', c['on-background'])
    set('--surface', c.surface)
    set('--primary', c.primary)
    set('--on-primary', c['on-primary'])
    style.colorScheme = message.dark ? 'dark' : 'light'
  }
})

function isPlaying(row) {
  const now = state.nowPlaying
  return !!now && now.title === row.item.title && now.album === row.item.album
}

// Only the rows change when the song does; re-rendering the page would lose
// the scroll position.
function markPlaying() {
  for (const el of view.querySelectorAll('.row[data-row]')) {
    const row = rowsOnScreen[el.dataset.row]
    if (!row) continue
    const playing = isPlaying(row)
    el.classList.toggle('playing', playing)
    el.querySelector('.num').innerHTML = playing
      ? '<span class="bars"><i></i><i></i><i></i></span>'
      : esc(el.dataset.number)
  }
}

// ── Rendering ──────────────────────────────────────────────────────────

let rowsOnScreen = []

function trackRows(rows, { showAlbum = false, albumArtist = '' } = {}) {
  rowsOnScreen = rows
  const discs = new Set(rows.map((r) => r.disc || 1))
  let lastDisc = null
  return rows
    .map((row, i) => {
      let heading = ''
      const disc = row.disc || 1
      if (discs.size > 1 && disc !== lastDisc) heading = `<div class="disc">Disc ${disc}</div>`
      lastDisc = disc
      const number = showAlbum ? i + 1 : (row.track ?? i + 1)
      const sub = showAlbum
        ? `${row.artist} · ${row.album}`
        : row.artist && row.artist !== albumArtist
          ? row.artist
          : ''
      return `${heading}
        <div class="row" data-row="${i}" data-number="${esc(number)}">
          <span class="num">${esc(number)}</span>
          <span><div class="title">${esc(row.title)}</div>${
            sub ? `<div class="row-sub">${esc(sub)}</div>` : ''
          }</span>
          <span class="time">${duration(row.duration)}</span>
          <span class="row-actions">
            <button title="Play" data-play="${i}" data-mode="now">${icon('play')}</button>
            <button title="Play next" data-play="${i}" data-mode="next">${icon('next')}</button>
            <button title="Add to queue" data-play="${i}" data-mode="queue">${icon('queue')}</button>
          </span>
        </div>`
    })
    .join('')
}

function albumTile(album) {
  const sub = album.artist
    ? `<a class="sub" href="#/artist/${encodeURIComponent(album.artist)}">${esc(album.artist)}</a>`
    : `<div class="sub">${plural(album.songs, 'song')}</div>`
  return `
    <div class="tile">
      <div class="cover-wrap">
        <a href="#/album/${album.id}" aria-label="${esc(album.title)}">${cover(album.id, album.cover, album.title)}</a>
        <button class="play-fab" title="Play" data-play-album="${album.id}">${icon('play')}</button>
      </div>
      <a class="name" href="#/album/${album.id}" style="display:block">${esc(album.title)}</a>
      ${sub}
    </div>`
}

const SORTS = {
  added: ['Recently added', (a, b) => b.added - a.added],
  title: ['Name', (a, b) => a.title.localeCompare(b.title)],
  artist: [
    'Artist',
    (a, b) => a.artist.localeCompare(b.artist) || (a.year ?? 0) - (b.year ?? 0),
  ],
  year: ['Year', (a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title)],
}

function renderAlbums() {
  const albums = [...state.albums].sort(SORTS[state.sort][1])
  const chips = Object.entries(SORTS)
    .map(
      ([key, [label]]) =>
        `<button class="chip ${key === state.sort ? 'active' : ''}" data-sort="${key}">${label}</button>`,
    )
    .join('')
  // Nothing to count or sort before the first scan has found anything.
  const tools = albums.length
    ? `<span class="count">${plural(albums.length, 'album')}</span><div class="chips">${chips}</div>`
    : ''
  view.innerHTML = `
    <div class="section-head"><h1>Albums</h1>${tools}</div>
    ${albums.length ? `<div class="grid">${albums.map(albumTile).join('')}</div>` : emptyLibrary()}`
}

function emptyLibrary() {
  if (state.status?.scanning) return `<div id="scan-progress" class="scan-card">${scanProgress()}</div>`
  return '<div class="empty">No music found in this folder yet.</div>'
}

// --- scan progress ---------------------------------------------------------------

// Reading rate, from the first moment of the reading phase: what the time
// left is estimated from. Reset by every new scan.
let readingSince = null

function timeLeft(progress) {
  if (progress.phase !== 'reading') {
    readingSince = null
    return ''
  }
  const now = Date.now()
  if (!readingSince || progress.read < readingSince.read) readingSince = { at: now, read: progress.read }
  const seconds = (now - readingSince.at) / 1000
  const done = progress.read - readingSince.read
  // A few seconds in, the rate means something.
  if (seconds < 5 || done < 1) return ''
  const left = ((progress.toRead - progress.read) / done) * seconds
  if (left < 60) return 'less than a minute left'
  if (left < 3600) return `about ${plural(Math.round(left / 60), 'minute')} left`
  return `about ${plural(Math.round(left / 3600), 'hour')} left`
}

function scanProgress() {
  const progress = state.status?.progress ?? { phase: 'looking', found: 0 }
  if (progress.phase !== 'reading') {
    return `
      <div class="scan-title">Looking for music…</div>
      <div class="meter meter--busy"><i></i></div>
      <div class="scan-numbers">${plural(progress.found, 'file')} found so far</div>`
  }
  const share = progress.toRead ? progress.read / progress.toRead : 1
  const rest = [`${count(progress.toRead - progress.read)} to go`, timeLeft(progress)]
  return `
    <div class="scan-title">Reading your music</div>
    <div class="meter"><i style="width:${(share * 100).toFixed(1)}%"></i></div>
    <div class="scan-numbers">
      <span>${count(progress.read)} of ${count(progress.toRead)} files</span>
      <span>${rest.filter(Boolean).join(' · ')}</span>
    </div>`
}

const scanBar = document.getElementById('scan-bar')

function showScanProgress() {
  const card = document.getElementById('scan-progress')
  if (card) card.innerHTML = scanProgress()
  // With music already there, only a scan with something new to read is worth a bar.
  const progress = state.status?.progress
  const reading = state.status?.scanning && progress?.phase === 'reading' && progress.toRead > 0
  scanBar.hidden = !(reading && !card)
  if (!scanBar.hidden) {
    const share = progress.read / progress.toRead
    scanBar.innerHTML = `
      <div class="meter"><i style="width:${(share * 100).toFixed(1)}%"></i></div>
      <span>Reading new music: ${count(progress.read)} of ${count(progress.toRead)}</span>`
  }
}

function renderArtists() {
  let letter = ''
  const rows = state.artists
    .map((artist) => {
      const first = (artist.name[0] || '#').toUpperCase()
      const heading = first !== letter ? `<div class="letter">${esc(first)}</div>` : ''
      letter = first
      return `${heading}
        <a class="artist-row" href="#/artist/${encodeURIComponent(artist.name)}">
          ${cover(artist.cover, !!artist.cover, artist.name)}
          <span class="artist-text"><div class="name">${esc(artist.name)}</div>
          <div class="sub">${plural(artist.albums, 'album')}</div></span>
        </a>`
    })
    .join('')
  view.innerHTML = `
    <div class="section-head"><h1>Artists</h1><span class="count">${plural(state.artists.length, 'artist')}</span></div>
    ${state.artists.length ? `<div class="artists">${rows}</div>` : emptyLibrary()}`
}

function renderArtist(name) {
  const albums = state.albums
    .filter((a) => (a.artist || 'Unknown artist') === name)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
  view.innerHTML = `
    <div class="section-head"><h1>${esc(name)}</h1><span class="count">${plural(albums.length, 'album')}</span>
      <button class="pill" data-play-artist>${icon('play')} Play</button></div>
    <div class="grid">${albums.map(albumTile).join('')}</div>`
}

async function renderAlbum(albumId) {
  view.innerHTML = '<div class="empty">Loading…</div>'
  let album
  try {
    album = await albumRows(albumId)
  } catch {
    view.innerHTML = '<div class="empty">This album is gone. The folder may have changed.</div>'
    return
  }
  const backdrop = album.cover
    ? `<div class="hero-backdrop" style="background-image:url('covers/${album.id}')"></div>`
    : `<div class="hero-backdrop" style="background:${tint(album.title)}"></div>`
  const artist = album.artist
    ? `<a href="#/artist/${encodeURIComponent(album.artist)}">${esc(album.artist)}</a> · `
    : ''
  const details = [album.year, album.genre, plural(album.songs, 'song'), longDuration(album.duration)]
    .filter(Boolean)
    .map(esc)
    .join(' · ')
  view.innerHTML = `
    <section class="hero">${backdrop}
      ${cover(album.id, album.cover, album.title)}
      <div>
        <div class="sub">Album</div>
        <h1>${esc(album.title)}</h1>
        <div class="meta">${artist}${details}</div>
        <div class="actions">
          <button class="pill" data-album-action="play">${icon('play')} Play</button>
          <button class="pill ghost" data-album-action="queue">${icon('queue')} Add to queue</button>
        </div>
      </div>
    </section>
    ${trackRows(album.tracks, { albumArtist: album.artist })}`
  view.dataset.album = album.id
  markPlaying()
}

let searchTimer
async function renderSearch() {
  const query = state.query
  const result = await api(`search?q=${encodeURIComponent(query)}`)
  if (query !== state.query) return
  const albums = result.albums.length
    ? `<div class="section-head"><h2>Albums</h2></div><div class="grid">${result.albums.map(albumTile).join('')}</div>`
    : ''
  const songs = result.tracks.length
    ? `<div class="section-head" style="margin-top:28px"><h2>Songs</h2>
         <button class="pill ghost" data-play-results>${icon('play')} Play all</button></div>
       ${trackRows(result.tracks, { showAlbum: true })}`
    : ''
  view.innerHTML = albums || songs ? albums + songs : `<div class="empty">Nothing found for “${esc(query)}”.</div>`
  markPlaying()
}

function route() {
  delete view.dataset.album
  const hash = decodeURIComponent(location.hash.slice(1) || '/')
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const active = tab.dataset.tab === (hash.startsWith('/artist') ? 'artists' : 'albums')
    tab.classList.toggle('active', active && !state.query)
  }
  if (state.query) return void renderSearch()
  if (hash.startsWith('/album/')) return void renderAlbum(hash.slice(7))
  if (hash.startsWith('/artist/')) return renderArtist(hash.slice(8))
  if (hash === '/artists') return renderArtists()
  return renderAlbums()
}

// ── Events ─────────────────────────────────────────────────────────────

view.addEventListener('click', async (event) => {
  const button = event.target.closest('button')
  if (!button) return
  const { dataset } = button
  if (dataset.sort) {
    state.sort = dataset.sort
    renderAlbums()
  } else if (dataset.play !== undefined) {
    const row = rowsOnScreen[dataset.play]
    const result = await send([row.item], dataset.mode)
    if (!result.ok) toast(result.error || 'Could not play that')
    else if (dataset.mode === 'next') toast(`${row.title} plays next`)
    else if (dataset.mode === 'queue') toast(`Added ${row.title}`)
  } else if (dataset.playAlbum) {
    const album = await albumRows(dataset.playAlbum)
    await playRows(album.tracks, { label: `Playing ${album.title}` })
  } else if (dataset.albumAction) {
    const album = await albumRows(view.dataset.album)
    const action = dataset.albumAction
    if (action === 'play') await playRows(album.tracks)
    if (action === 'queue') {
      await playRows(album.tracks, { mode: 'queue', label: `Added ${album.title}` })
    }
  } else if (dataset.playArtist !== undefined) {
    const name = decodeURIComponent(location.hash.slice(9))
    const albums = state.albums.filter((a) => (a.artist || 'Unknown artist') === name)
    const rows = (await Promise.all(albums.map((a) => albumRows(a.id)))).flatMap((a) => a.tracks)
    await playRows(rows, { label: `Playing ${name}` })
  } else if (dataset.playResults !== undefined) {
    await playRows(rowsOnScreen, { label: 'Playing the results' })
  }
})

searchInput.addEventListener('input', () => {
  state.query = searchInput.value.trim()
  clearTimeout(searchTimer)
  searchTimer = setTimeout(route, 180)
})

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== searchInput) {
    event.preventDefault()
    searchInput.focus()
  } else if (event.key === 'Escape' && document.activeElement === searchInput) {
    searchInput.value = ''
    state.query = ''
    route()
  }
})

window.addEventListener('hashchange', () => {
  if (state.query) {
    searchInput.value = ''
    state.query = ''
  }
  route()
  window.scrollTo(0, 0)
})

const rescanButton = document.getElementById('rescan')
rescanButton.addEventListener('click', async () => {
  state.status = await api('rescan', { method: 'POST' })
  followScan()
})

// While a scan runs, check back until it is done, then show what it found.
async function followScan() {
  rescanButton.classList.toggle('spinning', !!state.status?.scanning)
  showScanProgress()
  if (!state.status?.scanning) return
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const before = state.status.songs
  state.status = await api('status')
  if (!state.status.scanning) {
    scanBar.hidden = true
    await loadLibrary()
    const added = state.status.songs - before
    toast(added > 0 ? `Found ${plural(added, 'new song')}` : 'Up to date')
  }
  followScan()
}

async function loadLibrary() {
  const [albums, artists] = await Promise.all([api('albums'), api('artists')])
  state.albums = albums
  state.artists = artists
  state.albumCache.clear()
  route()
}

async function start() {
  document.getElementById('standalone').hidden = embedded
  // First, so Beacon's colours arrive before the library does.
  if (embedded) window.parent.postMessage({ type: 'beacon.ready' }, '*')
  state.status = await api('status')
  document.getElementById('brand').textContent = state.status.name
  document.title = state.status.name
  await loadLibrary()
  followScan()
}

start().catch((error) => {
  view.innerHTML = `<div class="empty">Could not load the library: ${esc(error.message)}</div>`
})
