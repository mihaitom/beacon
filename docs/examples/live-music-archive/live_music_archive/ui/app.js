// The Live Music Archive's page, shown by Beacon in a sandboxed frame: no
// cookies, no storage, everything in memory. It browses this app's API, which
// asks archive.org, and asks Beacon to play with postMessage (see Beacon's
// help page "External source API").
'use strict'

const view = document.getElementById('view')
const searchInput = document.getElementById('search')
const embedded = window.parent !== window

const state = {
  showCache: new Map(),
  query: '',
  nowPlaying: null,
  // The artist page, kept while "Show more" adds to it.
  artist: null,
}

// ── Helpers ────────────────────────────────────────────────────────────

const ICONS = {
  play: '<path d="M8 5v14l11-7z"/>',
  next: '<path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z"/>',
  queue: '<path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm16-1v-3h-2v3h-3v2h3v3h2v-3h3v-2z"/>',
  open: '<path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2"/>',
}
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

async function api(path) {
  const response = await fetch(`api/${path}`)
  if (!response.ok) {
    // The app says in words what archive.org did; that is worth showing.
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `${response.status} ${response.statusText}`)
  }
  return response.json()
}

function duration(seconds) {
  if (!seconds) return ''
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function longDuration(seconds) {
  const minutes = Math.round(seconds / 60)
  if (!minutes) return ''
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "1977-05-08" as a calendar sheet; archive.org has shows with only a year.
function dateParts(date) {
  const [year, month, day] = String(date || '')
    .split('-')
    .map(Number)
  if (!year) return { top: '?', year: '' }
  if (!month) return { top: '', year }
  return { top: `${day ? `${day} ` : ''}${MONTHS[month - 1] ?? ''}`, year }
}

// One colour per name for anything without a picture, the same every time.
function tint(text) {
  let hash = 0
  for (const c of String(text)) hash = (hash * 31 + c.charCodeAt(0)) | 0
  const hue = Math.abs(hash) % 360
  return `linear-gradient(135deg, hsl(${hue} 55% 45%), hsl(${(hue + 50) % 360} 60% 26%))`
}

function cover(identifier, name) {
  const letter = esc((name || '?').trim().charAt(0).toUpperCase() || '?')
  return `<div class="cover" style="background:${tint(name)}">${letter}<img src="images/${encodeURIComponent(identifier)}" alt="" loading="lazy" /></div>`
}

// Not every show or artist has a picture: the letter beneath shows instead.
document.addEventListener(
  'error',
  (event) => {
    if (event.target.tagName === 'IMG' && event.target.closest('.cover')) event.target.remove()
  },
  true,
)

function toast(text) {
  const el = document.getElementById('toast')
  el.textContent = text
  el.classList.add('show')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => el.classList.remove('show'), 2400)
}

// ── Talking to Beacon ──────────────────────────────────────────────────

// Beacon answers every beacon.play with beacon.played, in order. Waiting for
// the answer before the next request keeps a show in its order.
const waiting = []

function send(item, mode) {
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
    window.parent.postMessage({ type: 'beacon.play', mode, item }, '*')
  })
}

async function playRows(rows, { mode = 'now', label } = {}) {
  if (!rows.length) return
  for (const [i, row] of rows.entries()) {
    const result = await send(row.item, i === 0 ? mode : 'queue')
    if (!result.ok) {
      toast(result.error || 'Could not play that')
      return
    }
  }
  if (label) toast(label)
}

async function loadShow(showId) {
  if (!state.showCache.has(showId))
    state.showCache.set(showId, await api(`shows/${encodeURIComponent(showId)}`))
  return state.showCache.get(showId)
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

function trackRows(rows) {
  rowsOnScreen = rows
  return rows
    .map(
      (row, i) => `
        <div class="row" data-row="${i}" data-number="${i + 1}">
          <span class="num">${i + 1}</span>
          <span><div class="title">${esc(row.title)}</div></span>
          <span class="time">${duration(row.duration)}</span>
          <span class="row-actions">
            <button title="Play" data-play="${i}" data-mode="now">${icon('play')}</button>
            <button title="Play next" data-play="${i}" data-mode="next">${icon('next')}</button>
            <button title="Add to queue" data-play="${i}" data-mode="queue">${icon('queue')}</button>
          </span>
        </div>`,
    )
    .join('')
}

// On an artist's page the venue leads; everywhere else, who played.
function showRow(show, { withArtist = true } = {}) {
  const { top, year } = dateParts(show.date)
  const place = show.venue || show.title
  const name = withArtist ? show.artist || place : place
  const sub = [withArtist && place !== name && place, show.location, show.recording]
    .filter(Boolean)
    .map(esc)
    .join(' · ')
  return `
    <div class="show-row">
      <a class="show-link" href="#/show/${encodeURIComponent(show.id)}">
        <span class="date"><b>${esc(top)}</b><span>${esc(year)}</span></span>
        <span class="show-text"><div class="name">${esc(name)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</span>
      </a>
      <button class="icon-button" title="Play this show" data-play-show="${esc(show.id)}">${icon('play')}</button>
    </div>`
}

function artistRow(artist) {
  return `
    <a class="artist-row" href="#/artist/${encodeURIComponent(artist.id)}">
      ${cover(artist.id, artist.name)}
      <span class="artist-text"><div class="name">${esc(artist.name)}</div>
      <div class="sub">${plural(artist.shows, 'show')}</div></span>
    </a>`
}

function failure(error) {
  view.innerHTML = `<div class="empty">${esc(error.message)}</div>`
}

function longDate(date) {
  const [year, month, day] = String(date || '')
    .split('-')
    .map(Number)
  if (!year || !month) return String(year || '')
  return `${day ? `${day} ` : ''}${FULL_MONTHS[month - 1]} ${year}`
}

const FULL_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

// The week's most played show, large.
function feature(show) {
  const link = `#/show/${encodeURIComponent(show.id)}`
  const place = [show.venue, show.location].filter(Boolean).map(esc).join(' · ')
  return `
    <section class="feature">
      <div class="feature-backdrop" style="background-image:url('images/${encodeURIComponent(show.coverId)}')"></div>
      <a class="feature-cover" href="${link}">${cover(show.coverId, show.artist)}</a>
      <div class="feature-text">
        <div class="eyebrow">Most played this week</div>
        <a href="${link}"><h1>${esc(show.artist || show.title)}</h1></a>
        <div class="meta">${place}${place ? '<br />' : ''}${esc(longDate(show.date))}</div>
        <div class="actions">
          <button class="pill" data-play-show="${esc(show.id)}">${icon('play')} Play</button>
          <a class="pill ghost" href="${link}">Songs</a>
        </div>
      </div>
    </section>`
}

function card(show, sub) {
  const link = `#/show/${encodeURIComponent(show.id)}`
  return `
    <div class="card">
      <div class="cover-wrap">
        <a href="${link}" aria-label="${esc(show.artist)}">${cover(show.coverId, show.artist)}</a>
        <button class="play-fab" title="Play this show" data-play-show="${esc(show.id)}">${icon('play')}</button>
      </div>
      <a class="name" href="${link}">${esc(show.artist || show.title)}</a>
      <div class="sub">${esc(sub)}</div>
    </div>`
}

function shelf(title, note, cards) {
  if (!cards.length) return ''
  return `
    <section class="shelf">
      <div class="section-head"><h2>${esc(title)}</h2><span class="count">${esc(note)}</span></div>
      <div class="shelf-track">${cards.join('')}</div>
    </section>`
}

async function renderShows() {
  view.innerHTML = '<div class="empty">Loading…</div>'
  const home = await api('home')
  const { featured, week } = home
  const onThisDay = home.onThisDay.map((show) =>
    card(show, [show.date.slice(0, 4), show.venue || show.location].filter(Boolean).join(' · ')),
  )
  const favourites = home.favourites.map((show) =>
    card(
      show,
      [show.rating && `★ ${show.rating.toFixed(1)}`, show.date.slice(0, 4)]
        .filter(Boolean)
        .join(' · '),
    ),
  )
  view.innerHTML = `
    ${featured ? feature(featured) : ''}
    ${shelf('On this day', longDate(home.today).replace(/ \d+$/, ''), onThisDay)}
    ${shelf('Fan favourites', 'Rated best by listeners', favourites)}
    <div class="section-head section-head--spaced"><h2>Popular this week</h2></div>
    <div class="shows">${week.map((show) => showRow(show)).join('')}</div>`
}

async function renderArtists() {
  view.innerHTML = '<div class="empty">Loading…</div>'
  const artists = await api('artists')
  view.innerHTML = `
    <div class="section-head"><h1>Most played artists</h1></div>
    <div class="artists">${artists.map(artistRow).join('')}</div>
    <p class="hint">Every other artist is a search away.</p>`
}

const SORTS = { newest: 'Newest', oldest: 'Oldest', popular: 'Most played' }

async function loadArtist(artistId, sort, page) {
  const found = await api(`artists/${encodeURIComponent(artistId)}?sort=${sort}&page=${page}`)
  const before =
    state.artist?.id === artistId && state.artist.sort === sort && page > 1
      ? state.artist.shows
      : []
  state.artist = { ...found, sort, shows: [...before, ...found.shows] }
}

async function renderArtist(artistId) {
  if (state.artist?.id !== artistId) {
    view.innerHTML = '<div class="empty">Loading…</div>'
    await loadArtist(artistId, 'newest', 1)
  }
  const artist = state.artist
  const chips = Object.entries(SORTS)
    .map(
      ([key, label]) =>
        `<button class="chip ${key === artist.sort ? 'active' : ''}" data-sort="${key}">${label}</button>`,
    )
    .join('')
  const more =
    artist.shows.length < artist.total
      ? `<button class="pill ghost more" data-more>Show more</button>`
      : ''
  view.innerHTML = `
    <div class="section-head"><h1>${esc(artist.name)}</h1><span class="count">${plural(artist.total, 'show')}</span>
      <div class="chips">${chips}</div></div>
    ${
      artist.shows.length
        ? `<div class="shows">${artist.shows.map((show) => showRow(show, { withArtist: false })).join('')}</div>${more}`
        : '<div class="empty">No show of this artist can be played here.</div>'
    }`
}

async function renderShow(showId) {
  view.innerHTML = '<div class="empty">Loading…</div>'
  const show = await loadShow(showId)
  const image = `images/${encodeURIComponent(show.coverId)}`
  const artist = show.artistId
    ? `<a href="#/artist/${encodeURIComponent(show.artistId)}">${esc(show.artist)}</a>`
    : esc(show.artist)
  const details = [
    show.date,
    show.location,
    plural(show.songs, 'song'),
    longDuration(show.duration),
  ]
    .filter(Boolean)
    .map(esc)
  // Where the show comes from, one tap away: the archive's page has the
  // taper's notes and the band's terms.
  const source = `<a class="source" href="https://archive.org/details/${encodeURIComponent(show.id)}" target="_blank" rel="noopener">archive.org ${icon('open')}</a>`
  view.innerHTML = `
    <section class="hero"><div class="hero-backdrop" style="background-image:url('${image}')"></div>
      ${cover(show.coverId, show.artist)}
      <div>
        <div class="sub">Live</div>
        <h1>${esc(show.venue || show.title)}</h1>
        <div class="meta">${[artist, ...details, source].join(' · ')}</div>
        <div class="actions">
          <button class="pill" data-show-action="play">${icon('play')} Play</button>
          <button class="pill ghost" data-show-action="queue">${icon('queue')} Add to queue</button>
        </div>
      </div>
    </section>
    ${trackRows(show.tracks)}`
  view.dataset.show = show.id
  markPlaying()
}

let searchTimer
async function renderSearch() {
  const query = state.query
  view.innerHTML = '<div class="empty">Searching…</div>'
  const result = await api(`search?q=${encodeURIComponent(query)}`)
  if (query !== state.query) return
  const artists = result.artists.length
    ? `<div class="section-head"><h2>Artists</h2></div><div class="artists">${result.artists.map(artistRow).join('')}</div>`
    : ''
  const shows = result.shows.length
    ? `<div class="section-head section-head--spaced"><h2>Shows</h2></div>
       <div class="shows">${result.shows.map((show) => showRow(show)).join('')}</div>`
    : ''
  view.innerHTML =
    artists || shows
      ? artists + shows
      : `<div class="empty">Nothing found for “${esc(query)}”.</div>`
}

function route() {
  delete view.dataset.show
  const hash = decodeURIComponent(location.hash.slice(1) || '/')
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const active = tab.dataset.tab === (hash.startsWith('/artist') ? 'artists' : 'shows')
    tab.classList.toggle('active', active && !state.query)
  }
  let rendering
  if (state.query) rendering = renderSearch()
  else if (hash.startsWith('/show/')) rendering = renderShow(hash.slice(6))
  else if (hash.startsWith('/artist/')) rendering = renderArtist(hash.slice(8))
  else if (hash === '/artists') rendering = renderArtists()
  else rendering = renderShows()
  rendering.catch(failure)
}

// ── Events ─────────────────────────────────────────────────────────────

view.addEventListener('click', async (event) => {
  const button = event.target.closest('button')
  if (!button) return
  const { dataset } = button
  try {
    if (dataset.sort) {
      await loadArtist(state.artist.id, dataset.sort, 1)
      await renderArtist(state.artist.id)
    } else if (dataset.more !== undefined) {
      button.disabled = true
      const scroll = window.scrollY
      await loadArtist(state.artist.id, state.artist.sort, state.artist.page + 1)
      await renderArtist(state.artist.id)
      window.scrollTo(0, scroll)
    } else if (dataset.play !== undefined) {
      const row = rowsOnScreen[dataset.play]
      const result = await send(row.item, dataset.mode)
      if (!result.ok) toast(result.error || 'Could not play that')
      else if (dataset.mode === 'next') toast(`${row.title} plays next`)
      else if (dataset.mode === 'queue') toast(`Added ${row.title}`)
    } else if (dataset.playShow) {
      const show = await loadShow(dataset.playShow)
      await playRows(show.tracks, { label: `Playing ${show.album}` })
    } else if (dataset.showAction) {
      const show = await loadShow(view.dataset.show)
      if (dataset.showAction === 'play') await playRows(show.tracks)
      else await playRows(show.tracks, { mode: 'queue', label: `Added ${show.album}` })
    }
  } catch (error) {
    toast(error.message)
  }
})

searchInput.addEventListener('input', () => {
  state.query = searchInput.value.trim()
  clearTimeout(searchTimer)
  // archive.org is far away: wait for a pause in typing before asking.
  searchTimer = setTimeout(route, 400)
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

async function start() {
  document.getElementById('standalone').hidden = embedded
  // First, so Beacon's colours arrive before anything from archive.org does.
  if (embedded) window.parent.postMessage({ type: 'beacon.ready' }, '*')
  const status = await api('status')
  document.getElementById('brand').textContent = status.name
  document.title = status.name
  route()
}

start().catch(failure)
