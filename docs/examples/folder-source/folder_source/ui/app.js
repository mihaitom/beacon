// The folder source's page, shown by Beacon in a sandboxed frame: no cookies,
// no storage, everything in memory. It browses this app's API and asks Beacon
// to play with postMessage (see Beacon's help page "External source API").
'use strict'

const view = document.getElementById('view')
const searchInput = document.getElementById('search')
const embedded = window.parent !== window

const state = {
  // The music folder on screen (its key), and every folder from the status.
  folder: null,
  folders: [],
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
  album:
    '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 14.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9m0-5.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2"/>',
  artist: '<path d="M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8m0 10c4.42 0 8 1.79 8 4v2H4v-2c0-2.21 3.58-4 8-4"/>',
  // Material Design Icons' folder-outline and folder-open, as Beacon has them.
  folder: '<path d="M20 18H4V8h16m0-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2"/>',
  folderOpen:
    '<path d="M19 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6l2 2h7a2 2 0 0 1 2 2H4v10l2.14-8h17.07l-2.28 8.5c-.23.87-1.01 1.5-1.93 1.5"/>',
}
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`

const esc = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

async function api(path, options) {
  const response = await fetch(`api/${path}`, options)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

// The same, for the folder on screen.
const folderApi = (path) => api(`${state.folder}/${path}`)

// Addresses in the page carry the folder: #/<folder>/album/<id>.
const link = (path) => `#/${state.folder}${path}`

function duration(seconds) {
  if (!seconds) return ''
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function longDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

const count = (n) => n.toLocaleString()
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`

// Without a cover: Beacon's faint fill and a quiet record (or person).
function cover(albumId, hasCover, { full = false, kind = 'album' } = {}) {
  const src = `covers/${state.folder}/${albumId}${full ? '' : '?size=thumb'}`
  const image = hasCover ? `<img src="${src}" alt="" loading="lazy" />` : ''
  return `<div class="cover">${icon(kind)}${image}</div>`
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
  const parts = []
  for (let start = 0; start < rows.length; start += MAX_PER_MESSAGE) {
    parts.push(rows.slice(start, start + MAX_PER_MESSAGE).map((row) => row.item))
  }
  // "next" puts every message straight after the song playing: the last part
  // goes first, so the songs keep their order. Otherwise the first part
  // starts (or joins) the queue and the rest follow it at the end.
  const messages =
    mode === 'next'
      ? parts.reverse().map((items) => [items, 'next'])
      : parts.map((items, i) => [items, i ? 'queue' : mode])
  for (const [items, messageMode] of messages) {
    const result = await send(items, messageMode)
    if (!result.ok) {
      toast(result.error || 'Could not play that')
      return
    }
  }
  if (label) toast(label)
}

// What the toast says after a song, an album or an artist went somewhere.
function playedLabel(name, mode) {
  if (mode === 'next') return `${name} plays next`
  if (mode === 'queue') return `Added ${name}`
  return ''
}

const playSong = (row, mode) => playRows([row], { mode, label: playedLabel(row.title, mode) })

async function playAlbum(albumId, mode, { label = true } = {}) {
  const album = await albumRows(albumId)
  const text = mode === 'now' ? `Playing ${album.title}` : playedLabel(album.title, mode)
  await playRows(album.tracks, { mode, label: label ? text : '' })
}

const artistAlbums = (name) => state.albums.filter((a) => (a.artist || 'Unknown artist') === name)

async function playArtist(name, mode) {
  const albums = artistAlbums(name).sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
  const rows = (await Promise.all(albums.map((a) => albumRows(a.id)))).flatMap((a) => a.tracks)
  await playRows(rows, { mode, label: mode === 'now' ? `Playing ${name}` : playedLabel(name, mode) })
}

async function albumRows(albumId) {
  if (!state.albumCache.has(albumId)) {
    state.albumCache.set(albumId, await folderApi(`albums/${albumId}`))
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
    document.documentElement.dataset.theme = message.dark ? 'dark' : 'light'
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

// ── Long lists ─────────────────────────────────────────────────────────

// A folder of thousands of albums put every tile and cover in the page at
// once, and took the browser down. Only the rows near the screen are in the
// page; the rest is empty space of the right height. A row that scrolls away
// leaves the page with its pictures, so the browser can let them go.

// Rows kept in the page above and below the screen, so a fast scroll does
// not show empty space.
const AHEAD_PX = 1200

let virtualList = null

/** Lays `items` out in `container` (a .grid or .artists element, whose CSS
 * decides the columns), one row of the grid at a time. With `headingOf`, a
 * new heading starts a new row: the artists' letters. */
function mountVirtual(container, items, { renderItem, headingOf, renderHeading }) {
  unmountVirtual()
  const list = { container, rows: [], offsets: [], heights: [], shown: new Map(), width: 0 }
  container.classList.add('virtual')

  function layout() {
    list.width = container.clientWidth
    const style = getComputedStyle(container)
    const columns = Math.max(1, style.gridTemplateColumns.split(' ').length)
    const rowGap = parseFloat(style.rowGap) || 0
    list.columns = columns

    list.rows = []
    let heading = null
    let row = null
    items.forEach((item, index) => {
      const next = headingOf ? headingOf(item) : null
      if (next !== heading) {
        heading = next
        list.rows.push({ heading, start: index })
        row = null
      }
      if (!row || row.items.length === columns) {
        row = { items: [], start: index }
        list.rows.push(row)
      }
      row.items.push(item)
    })

    // Every row of items is as tall as every other (one line of name, one
    // of detail), every heading too: measure one of each.
    const measure = (row) => {
      const el = rowElement(row, 0)
      container.append(el)
      const height = el.offsetHeight
      el.remove()
      return height
    }
    const itemRow = list.rows.find((r) => r.items)
    const headingRow = list.rows.find((r) => r.heading !== undefined)
    const itemHeight = itemRow ? measure(itemRow) : 0
    const headingHeight = headingRow ? measure(headingRow) : 0

    let top = 0
    list.offsets = []
    list.heights = []
    for (const r of list.rows) {
      const height = r.items ? itemHeight : headingHeight
      list.offsets.push(top)
      list.heights.push(height)
      // Headings sit on their own margins; rows of items keep the grid's gap.
      top += height + (r.items ? rowGap : 0)
    }
    container.style.height = `${Math.max(0, top - rowGap)}px`
    for (const el of list.shown.values()) el.remove()
    list.shown.clear()
    update()
  }

  function rowElement(row, top) {
    const el = document.createElement('div')
    el.style.top = `${top}px`
    if (row.items) {
      el.className = 'vrow'
      el.style.gridTemplateColumns = `repeat(${list.columns}, minmax(0, 1fr))`
      el.innerHTML = row.items.map((item, i) => renderItem(item, row.start + i)).join('')
    } else {
      el.className = 'vrow vrow--heading'
      el.innerHTML = renderHeading(row.heading)
    }
    return el
  }

  // The first row whose bottom is below `y`.
  function rowAt(y) {
    let low = 0
    let high = list.rows.length - 1
    while (low < high) {
      const mid = (low + high) >> 1
      if (list.offsets[mid] + list.heights[mid] < y) low = mid + 1
      else high = mid
    }
    return low
  }

  function update() {
    if (!container.isConnected) return unmountVirtual()
    if (!list.rows.length) return
    const top = -container.getBoundingClientRect().top
    const first = rowAt(top - AHEAD_PX)
    const last = rowAt(top + window.innerHeight + AHEAD_PX)
    for (const [index, el] of list.shown) {
      if (index < first || index > last) {
        el.remove()
        list.shown.delete(index)
      }
    }
    for (let index = first; index <= last; index++) {
      if (list.shown.has(index)) continue
      const el = rowElement(list.rows[index], list.offsets[index])
      container.append(el)
      list.shown.set(index, el)
    }
  }

  let frame = 0
  list.onScroll = () => {
    if (!frame) frame = requestAnimationFrame(() => ((frame = 0), update()))
  }
  // Only a change of width can change the columns.
  list.resize = new ResizeObserver(() => {
    if (container.isConnected && container.clientWidth !== list.width) layout()
  })
  list.resize.observe(container)
  // Under the sticky header is not on screen.
  const headerHeight = () => document.querySelector('.bar').offsetHeight

  // The first item at the top of the screen, for the A-Z index.
  list.indexAtTop = () => {
    if (!list.rows.length) return 0
    const top = headerHeight() - container.getBoundingClientRect().top
    return list.rows[rowAt(Math.max(0, top))].start
  }

  list.scrollToIndex = (index) => {
    let low = 0
    let high = list.rows.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (list.rows[mid].start <= index) low = mid
      else high = mid - 1
    }
    // Its letter's heading, where there is one, comes into view with it.
    const before = list.rows[low - 1]
    if (before && !before.items && before.start === list.rows[low].start) low--
    const page = container.getBoundingClientRect().top + window.scrollY
    window.scrollTo(0, page + list.offsets[low] - headerHeight() - 8)
  }

  // For items that arrive later: draws the rows on screen again.
  list.refresh = () => {
    for (const el of list.shown.values()) el.remove()
    list.shown.clear()
    update()
  }
  window.addEventListener('scroll', list.onScroll, { passive: true })
  window.addEventListener('resize', list.onScroll)
  virtualList = list
  layout()
}

function unmountVirtual() {
  unmountIndex()
  if (!virtualList) return
  window.removeEventListener('scroll', virtualList.onScroll)
  window.removeEventListener('resize', virtualList.onScroll)
  virtualList.resize.disconnect()
  virtualList = null
}

// ── A-Z index ──────────────────────────────────────────────────────────

// Along the right edge of a long list sorted by name: tap a letter, or slide
// along it. Thousands of albums are not something to scroll through.

const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']

/** The same as the server's letter(): "Ärzte" under A, digits under #. */
function letterOf(text) {
  const first = String(text || '').normalize('NFD').charAt(0).toUpperCase()
  return first >= 'A' && first <= 'Z' ? first : '#'
}

function firstIndexes(items, nameOf) {
  const firsts = {}
  items.forEach((item, index) => {
    const letter = letterOf(nameOf(item))
    if (!(letter in firsts)) firsts[letter] = index
  })
  return firsts
}

const azBar = document.getElementById('az')
let azIndex = null

// The index starts below the header, whose height depends on the width.
new ResizeObserver(([entry]) => {
  const height = entry.target.offsetHeight
  document.documentElement.style.setProperty('--bar-height', `${height}px`)
}).observe(document.querySelector('.bar'))

/** `firsts`: each letter's first index in the virtual list on screen. */
function mountIndex(firsts) {
  azIndex = { firsts, order: Object.entries(firsts).sort((a, b) => a[1] - b[1]) }
  azBar.innerHTML = LETTERS.map(
    (letter) => `<span data-letter="${letter}" class="${letter in firsts ? '' : 'none'}">${letter}</span>`,
  ).join('')
  azBar.hidden = false
  document.body.classList.add('has-az')
  markLetter()
}

function unmountIndex() {
  azIndex = null
  azBar.hidden = true
  document.body.classList.remove('has-az')
}

function markLetter() {
  if (!azIndex || !virtualList) return
  // The letter just tapped stays lit while nothing else moved the page: near
  // the end of a list the page cannot scroll that letter to the top.
  const jumped = azIndex.jumped
  let current = jumped && Math.abs(window.scrollY - jumped.y) < 2 ? jumped.letter : null
  if (!current) {
    azIndex.jumped = null
    const top = virtualList.indexAtTop()
    for (const [letter, first] of azIndex.order) {
      if (first > top) break
      current = letter
    }
  }
  for (const el of azBar.children) el.classList.toggle('on', el.dataset.letter === current)
}

function jumpTo(letter) {
  if (!azIndex || !virtualList) return
  // A letter with nothing under it goes to the next one that has something.
  const target = LETTERS.slice(LETTERS.indexOf(letter)).find((l) => l in azIndex.firsts)
  const [shown, first] = target ? [target, azIndex.firsts[target]] : azIndex.order.at(-1)
  virtualList.scrollToIndex(first)
  azIndex.jumped = { letter: shown, y: window.scrollY }
  markLetter()
}

// From the position, not from the letter under the finger: on a short screen
// the letters are close, and a slide must not skip any.
function letterAt(y) {
  const box = azBar.getBoundingClientRect()
  const share = (y - box.top) / box.height
  return LETTERS[Math.min(LETTERS.length - 1, Math.max(0, Math.floor(share * LETTERS.length)))]
}

azBar.addEventListener('pointerdown', (event) => {
  event.preventDefault()
  azBar.setPointerCapture(event.pointerId)
  azBar.classList.add('sliding')
  jumpTo(letterAt(event.clientY))
})
azBar.addEventListener('pointermove', (event) => {
  if (azBar.hasPointerCapture(event.pointerId)) jumpTo(letterAt(event.clientY))
})
for (const type of ['pointerup', 'pointercancel']) {
  azBar.addEventListener(type, () => azBar.classList.remove('sliding'))
}

let letterFrame = 0
window.addEventListener(
  'scroll',
  () => {
    if (azIndex && !letterFrame) letterFrame = requestAnimationFrame(() => ((letterFrame = 0), markLetter()))
  },
  { passive: true },
)

// ── Rendering ──────────────────────────────────────────────────────────

let rowsOnScreen = []

// What Beacon's song table says in its Format column: "FLAC · 953 kbps".
function formatText(row) {
  if (!row.format) return ''
  return row.bitrate ? `${row.format} · ${row.bitrate} kbps` : row.format
}

// An album's quality in one line: "FLAC · 24 bit / 96 kHz", "MP3 · 320 kbps".
function albumQuality(tracks) {
  const formats = new Set(tracks.map((t) => t.format))
  if (formats.size !== 1 || !tracks[0].format) return ''
  const first = tracks[0]
  if (first.bitDepth && first.sampleRate) {
    const same = tracks.every((t) => t.bitDepth === first.bitDepth && t.sampleRate === first.sampleRate)
    if (same) return `${first.format} · ${first.bitDepth} bit / ${first.sampleRate / 1000} kHz`
  }
  const rates = tracks.map((t) => t.bitrate).filter(Boolean)
  if (!rates.length) return first.format
  const low = Math.min(...rates)
  const high = Math.max(...rates)
  return `${first.format} · ${low === high ? low : `${low}-${high}`} kbps`
}

/** The column headings over a list of songs, in the rows' own grid. `full`:
 * a list of songs from anywhere (cover, album, year); otherwise one album's. */
function trackHead(full) {
  const columns = full
    ? ['#', '', 'Title', 'Album', 'Year', 'Format', 'Time', '']
    : ['#', 'Title', 'Format', 'Time', '']
  const align = (label) => (['#', 'Year', 'Format', 'Time'].includes(label) ? ' style="text-align:right"' : '')
  return `<div class="row row--head ${full ? 'row--full' : 'row--album'}" aria-hidden="true">${columns
    .map((label) => `<span${align(label)}>${label}</span>`)
    .join('')}</div>`
}

function trackRows(rows, { full = false, albumArtist = '' } = {}) {
  rowsOnScreen = rows
  const discs = new Set(rows.map((r) => r.disc || 1))
  let lastDisc = null
  const body = rows
    .map((row, i) => {
      let heading = ''
      const disc = row.disc || 1
      if (!full && discs.size > 1 && disc !== lastDisc) heading = `<div class="disc">Disc ${disc}</div>`
      lastDisc = disc
      const number = full ? i + 1 : (row.track ?? i + 1)
      const showArtist = full || (row.artist && row.artist !== albumArtist)
      return heading + trackRow(row, i, number, { full, showArtist })
    })
    .join('')
  return trackHead(full) + body
}

function trackRow(row, i, number, { full = false, showArtist = true } = {}) {
  const sub = [
    showArtist && row.artist ? esc(row.artist) : '',
    full && row.album ? `<span class="sub-album">${row.artist ? ' · ' : ''}${esc(row.album)}</span>` : '',
  ].join('')
  const album = row.albumId
    ? `<a class="col-album" href="${link(`/album/${row.albumId}`)}">${esc(row.album)}</a>`
    : `<span class="col-album">${esc(row.album)}</span>`
  return `
    <div class="row ${full ? 'row--full' : 'row--album'}" data-row="${i}" data-number="${esc(number)}">
      <span class="num">${esc(number)}</span>${full ? `<span class="row-cover">${cover(row.albumId, row.cover)}</span>` : ''}
      <span><div class="title">${esc(row.title)}</div>${sub ? `<div class="row-sub">${sub}</div>` : ''}</span>
      ${full ? `${album}<span class="col-year">${esc(row.year ?? '')}</span>` : ''}
      <span class="col-format">${esc(formatText(row))}</span>
      <span class="time">${duration(row.duration)}</span>
      <span class="row-actions">
        <button title="Play" data-play="${i}" data-mode="now">${icon('play')}</button>
        <button title="Play next" data-play="${i}" data-mode="next">${icon('next')}</button>
        <button title="Add to queue" data-play="${i}" data-mode="queue">${icon('queue')}</button>
      </span>
    </div>`
}

function albumTile(album) {
  const sub = album.artist
    ? `<a class="sub" href="${link(`/artist/${encodeURIComponent(album.artist)}`)}">${esc(album.artist)}</a>`
    : `<div class="sub">${plural(album.songs, 'song')}</div>`
  return `
    <div class="tile" data-menu-album="${album.id}">
      <div class="cover-wrap">
        <a href="${link(`/album/${album.id}`)}" aria-label="${esc(album.title)}">${cover(album.id, album.cover)}</a>
        <button class="play-fab" title="Play" data-play-album="${album.id}">${icon('play')}</button>
      </div>
      <a class="name" href="${link(`/album/${album.id}`)}">${esc(album.title)}</a>
      ${sub}
    </div>`
}

function sortSelect(list, labels, current) {
  const options = Object.entries(labels)
    .map(([key, label]) => `<option value="${key}" ${key === current ? 'selected' : ''}>${label}</option>`)
    .join('')
  return `<select class="sort-select" data-sort-select="${list}" aria-label="Sort by">${options}</select>`
}

// [label, order, the name the A-Z index goes by (none: no index)]
const SORTS = {
  added: ['Recently added', (a, b) => b.added - a.added],
  title: ['Name', (a, b) => a.title.localeCompare(b.title), (a) => a.title],
  artist: [
    'Artist',
    (a, b) => a.artist.localeCompare(b.artist) || (a.year ?? 0) - (b.year ?? 0),
    (a) => a.artist,
  ],
  year: ['Year', (a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title)],
}

// Newest album up front, the next ones in a shelf. Only for a library big
// enough to have a "newest": with a handful, it would show them all twice.
const SHELF_FROM = 8
const SHELF_SIZE = 14

function backdrop(album, { full = false } = {}) {
  if (!album.cover) return ''

  // Blurred beyond recognition: the small cover does as well as the big one.
  const src = `covers/${state.folder}/${album.id}${full ? '' : '?size=thumb'}`
  return `<div class="backdrop" style="background-image:url('${src}')"></div>`
}

function feature(album) {
  const meta = [album.artist, album.year, plural(album.songs, 'song')].filter(Boolean).map(esc)
  return `
    <section class="hero hero--feature" data-menu-album="${album.id}">${backdrop(album)}
      <a href="${link(`/album/${album.id}`)}">${cover(album.id, album.cover)}</a>
      <div class="hero-text">
        <div class="eyebrow">Just added</div>
        <a class="hero-title" href="${link(`/album/${album.id}`)}">${esc(album.title)}</a>
        <div class="meta">${meta.join(' · ')}</div>
        <div class="actions"><button class="pill" data-play-album="${album.id}">${icon('play')} Play</button></div>
      </div>
    </section>`
}

function renderAlbums() {
  const [, order, nameOf] = SORTS[state.sort]
  const albums = [...state.albums].sort(order)
  const labels = Object.fromEntries(Object.entries(SORTS).map(([key, [label]]) => [key, label]))
  // Nothing to count or sort before the first scan has found anything.
  const tools = albums.length
    ? `<span class="count">${plural(albums.length, 'album')}</span>${sortSelect('albums', labels, state.sort)}`
    : ''
  const newest = albums.length >= SHELF_FROM ? [...state.albums].sort(SORTS.added[1]) : []
  const top = newest.length
    ? `${feature(newest[0])}
       <div class="section-head"><h2>Recently added</h2></div>
       <div class="shelf">${newest.slice(1, SHELF_SIZE + 1).map(albumTile).join('')}</div>`
    : ''
  const heading = top ? '<h2>All albums</h2>' : '<h1>Albums</h1>'
  view.innerHTML = `${top}
    <div class="section-head">${heading}${tools}</div>
    ${albums.length ? '<div class="grid"></div>' : emptyLibrary()}`
  if (!albums.length) return
  mountVirtual(view.querySelector('.grid'), albums, { renderItem: albumTile })
  if (nameOf) mountIndex(firstIndexes(albums, nameOf))
}

const folderStatus = () => state.status?.folders.find((f) => f.key === state.folder)
const totalSongs = () => state.status.folders.reduce((sum, f) => sum + f.songs, 0)

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
  const progress = folderStatus()?.progress ?? { phase: 'looking', found: 0 }
  // Folders are scanned one after the other.
  if (!progress.phase && state.status?.scanning) {
    return `
      <div class="scan-title">Waiting for the other folders…</div>
      <div class="meter meter--busy"><i></i></div>`
  }
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
  const progress = folderStatus()?.progress
  const reading = progress?.phase === 'reading' && progress.toRead > 0
  scanBar.hidden = !(reading && !card)
  if (!scanBar.hidden) {
    const share = progress.read / progress.toRead
    scanBar.innerHTML = `
      <div class="meter"><i style="width:${(share * 100).toFixed(1)}%"></i></div>
      <span>Reading new music: ${count(progress.read)} of ${count(progress.toRead)}</span>`
  }
}

const artistLetter = (artist) => letterOf(artist.name)

function artistRow(artist) {
  return `
    <a class="artist-row" href="${link(`/artist/${encodeURIComponent(artist.name)}`)}" data-menu-artist="${esc(artist.name)}">
      ${cover(artist.cover, !!artist.cover, { kind: 'artist' })}
      <span class="artist-text"><div class="name">${esc(artist.name)}</div>
      <div class="sub">${plural(artist.albums, 'album')}</div></span>
    </a>`
}

function renderArtists() {
  view.innerHTML = `
    <div class="section-head"><h1>Artists</h1><span class="count">${plural(state.artists.length, 'artist')}</span></div>
    ${state.artists.length ? '<div class="artists"></div>' : emptyLibrary()}`
  if (!state.artists.length) return
  mountVirtual(view.querySelector('.artists'), state.artists, {
    renderItem: artistRow,
    headingOf: artistLetter,
    renderHeading: (letter) => `<div class="letter">${esc(letter)}</div>`,
  })
  mountIndex(firstIndexes(state.artists, (artist) => artist.name))
}

// --- songs -------------------------------------------------------------------------

// Thousands of songs, each with its signed addresses, are too much for one
// answer: the list fetches them a page at a time as they come on screen.
const SONGS_PAGE = 200

const SONG_SORTS = { title: 'Title', artist: 'Artist', album: 'Album', added: 'Recently added' }

const songs = { sort: 'title', total: 0, rows: [], letters: null, loading: new Set(), generation: 0 }

function resetSongs() {
  songs.rows = []
  songs.letters = null
  songs.loading.clear()
  songs.generation++
}

async function loadSongPage(page) {
  if (songs.loading.has(page)) return
  songs.loading.add(page)
  const generation = songs.generation
  let result
  try {
    result = await folderApi(`songs?sort=${songs.sort}&offset=${page * SONGS_PAGE}&limit=${SONGS_PAGE}`)
  } finally {
    // Loaded rows are not asked for again; a failed page is, when it next shows.
    if (generation === songs.generation) songs.loading.delete(page)
  }
  // Sorted differently or rescanned meanwhile: the answer is for another list.
  if (generation !== songs.generation) return
  songs.total = result.total
  if (result.letters) songs.letters = result.letters
  result.rows.forEach((row, i) => (songs.rows[page * SONGS_PAGE + i] = row))
  return result
}

function songRow(index) {
  const row = songs.rows[index]
  if (!row) {
    loadSongPage(Math.floor(index / SONGS_PAGE))
      .then((loaded) => {
        if (loaded && virtualList) {
          virtualList.refresh()
          markPlaying()
        }
      })
      .catch((error) => console.warn('Could not load songs:', error))
    // Two lines, like a loaded row, so nothing moves when it arrives.
    return `<div class="row row--full row--waiting"><span class="num">${index + 1}</span>
      <span class="row-cover"><div class="cover"></div></span>
      <span><div class="title">&nbsp;</div><div class="row-sub">&nbsp;</div></span></div>`
  }
  return trackRow(row, index, index + 1, { full: true })
}

async function renderSongs() {
  view.innerHTML = '<div class="empty">Loading…</div>'
  if (!songs.rows.length) await loadSongPage(0)
  if (currentPath() !== '/songs' || state.query) return
  rowsOnScreen = songs.rows
  const tools = songs.total
    ? `<span class="count">${plural(songs.total, 'song')}</span>${sortSelect('songs', SONG_SORTS, songs.sort)}`
    : ''
  view.innerHTML = `
    <div class="section-head"><h1>Songs</h1>${tools}</div>
    ${songs.total ? `<div class="song-table">${trackHead(true)}<div class="songs"></div></div>` : emptyLibrary()}`
  if (!songs.total) return
  const list = view.querySelector('.songs')
  // The headings' number column has to be as wide as the rows'.
  view.querySelector('.song-table').style.setProperty('--num-width', `${String(songs.total).length + 0.5}ch`)
  const indexes = Array.from({ length: songs.total }, (_, i) => i)
  mountVirtual(list, indexes, { renderItem: songRow })
  if (songs.letters && Object.keys(songs.letters).length) mountIndex(songs.letters)
  markPlaying()
}

function renderArtist(name) {
  const albums = artistAlbums(name).sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
  view.innerHTML = `
    <div class="section-head"><h1>${esc(name)}</h1><span class="count">${plural(albums.length, 'album')}</span>
      <button class="pill" data-play-artist>${icon('play')} Play</button></div>
    <div class="grid"></div>`
  mountVirtual(view.querySelector('.grid'), albums, { renderItem: albumTile })
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
  const artist = album.artist
    ? `<a href="${link(`/artist/${encodeURIComponent(album.artist)}`)}">${esc(album.artist)}</a> · `
    : ''
  const details = [
    album.year,
    album.genre,
    plural(album.songs, 'song'),
    longDuration(album.duration),
    albumQuality(album.tracks),
  ]
    .filter(Boolean)
    .map(esc)
    .join(' · ')
  view.innerHTML = `
    <section class="hero">${backdrop(album, { full: true })}
      ${cover(album.id, album.cover, { full: true })}
      <div class="hero-text">
        <div class="eyebrow">Album</div>
        <h1 class="hero-title">${esc(album.title)}</h1>
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
  const result = await folderApi(`search?q=${encodeURIComponent(query)}`)
  if (query !== state.query) return
  const albums = result.albums.length
    ? `<div class="section-head"><h2>Albums</h2></div><div class="grid">${result.albums.map(albumTile).join('')}</div>`
    : ''
  const songs = result.tracks.length
    ? `<div class="section-head" style="margin-top:28px"><h2>Songs</h2>
         <button class="pill ghost" data-play-results>${icon('play')} Play all</button></div>
       ${trackRows(result.tracks, { full: true })}`
    : ''
  view.innerHTML = albums || songs ? albums + songs : `<div class="empty">Nothing found for “${esc(query)}”.</div>`
  markPlaying()
}

// #/<folder>/<path>: the folder's key, and the page within it. A key no
// folder has (an old address, a folder taken out) means the first folder.
function parseHash() {
  const [, key = '', rest = ''] = location.hash.match(/^#\/([^/]*)(.*)$/) || []
  const known = state.folders.some((f) => f.key === key)
  return { key: known ? key : state.folders[0]?.key, path: decodeURIComponent(rest) || '/' }
}

const currentPath = () => parseHash().path

const SECTIONS = { albums: '/', artists: '/artists', songs: '/songs' }

function sectionOf(path) {
  return path.startsWith('/artist') ? 'artists' : path === '/songs' ? 'songs' : 'albums'
}

const foldersBar = document.getElementById('folders')

// Switching folders keeps the section: from one folder's songs to the next one's.
// The folder on screen is the open one.
function renderFolders(section) {
  foldersBar.hidden = state.folders.length < 2
  foldersBar.innerHTML = state.folders
    .map((f) => {
      const active = f.key === state.folder
      const songs = state.status?.folders.find((s) => s.key === f.key)?.songs
      const size = songs ? `<span class="songs" title="${plural(songs, 'song')}">${count(songs)}</span>` : ''
      return `<a href="#/${f.key}${SECTIONS[section]}" class="${active ? 'active' : ''}"${active ? ' aria-current="page"' : ''}>
        ${icon(active ? 'folderOpen' : 'folder')}<span>${esc(f.name)}</span>${size}</a>`
    })
    .join('')
  const name = state.folders.find((f) => f.key === state.folder)?.name
  searchInput.placeholder = state.folders.length > 1 && name ? `Search ${name}` : 'Search'
}

function route() {
  unmountVirtual()
  delete view.dataset.album
  const { key, path: hash } = parseHash()
  if (key !== state.folder) {
    state.folder = key
    view.innerHTML = '<div class="empty">Loading…</div>'
    return void loadLibrary().catch((error) => {
      view.innerHTML = `<div class="empty">Could not load this folder: ${esc(error.message)}</div>`
    })
  }
  const section = sectionOf(hash)
  renderFolders(section)
  document.getElementById('brand').setAttribute('href', link('/'))
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.setAttribute('href', link(SECTIONS[tab.dataset.tab]))
    tab.classList.toggle('active', tab.dataset.tab === section && !state.query)
  }
  if (state.query) return void renderSearch()
  if (hash.startsWith('/album/')) return void renderAlbum(hash.slice(7))
  if (hash.startsWith('/artist/')) return renderArtist(hash.slice(8))
  if (hash === '/artists') return renderArtists()
  if (hash === '/songs') return void renderSongs()
  return renderAlbums()
}

// ── Right-click menu ───────────────────────────────────────────────────

// Beacon's own right-click menu, for songs, albums and artists: cut into
// Beacon's sections (Playback, then Navigation; this page has nothing for
// Library or Dialogs), each under its heading, in Beacon's order. Inside the
// frame Beacon's menu cannot open, so without this a right-click got the
// browser's.

const menu = document.getElementById('menu')
let menuReturnFocus = null

const go = (path) => (location.hash = link(path))

function songMenu(row) {
  const album = state.albums.find((a) => a.id === row.albumId)
  const onAlbum = view.dataset.album === row.albumId
  return [
    [
      'Playback',
      [
        ['play', 'Play', () => playSong(row, 'now')],
        ['next', 'Play next', () => playSong(row, 'next')],
        ['queue', 'Add to queue', () => playSong(row, 'queue')],
      ],
    ],
    [
      'Navigation',
      [
        row.albumId && !onAlbum && ['album', 'Go to album', () => go(`/album/${row.albumId}`)],
        album?.artist && ['artist', 'Go to artist', () => go(`/artist/${encodeURIComponent(album.artist)}`)],
      ],
    ],
  ]
}

function albumMenu(albumId) {
  const album = state.albums.find((a) => a.id === albumId)
  return [
    [
      'Playback',
      [
        ['play', 'Play', () => playAlbum(albumId, 'now')],
        ['next', 'Play next', () => playAlbum(albumId, 'next')],
        ['queue', 'Add to queue', () => playAlbum(albumId, 'queue')],
      ],
    ],
    [
      'Navigation',
      [
        ['album', 'Go to album', () => go(`/album/${albumId}`)],
        album?.artist && ['artist', 'Go to artist', () => go(`/artist/${encodeURIComponent(album.artist)}`)],
      ],
    ],
  ]
}

function artistMenu(name) {
  return [
    [
      'Playback',
      [
        ['play', 'Play', () => playArtist(name, 'now')],
        ['next', 'Play next', () => playArtist(name, 'next')],
        ['queue', 'Add to queue', () => playArtist(name, 'queue')],
      ],
    ],
    ['Navigation', [['artist', 'Go to artist', () => go(`/artist/${encodeURIComponent(name)}`)]]],
  ]
}

/** What a right-click on `target` offers, or null: then the browser's own. */
function menuFor(target) {
  const row = target.closest('.row[data-row]')
  if (row) return rowsOnScreen[row.dataset.row] ? songMenu(rowsOnScreen[row.dataset.row]) : null
  const album = target.closest('[data-menu-album]')
  if (album) return albumMenu(album.dataset.menuAlbum)
  const artist = target.closest('[data-menu-artist]')
  if (artist) return artistMenu(artist.dataset.menuArtist)
  return null
}

let menuActions = []

function openMenu(sections, x, y) {
  menuActions = []
  menu.innerHTML = sections
    .map(([label, items]) => [label, items.filter(Boolean)])
    .filter(([, items]) => items.length)
    .map(
      ([label, items]) =>
        `<div class="menu-section" role="presentation">${esc(label)}</div>` +
        items
          .map(([name, text, action]) => {
            menuActions.push(action)
            const index = menuActions.length - 1
            return `<button class="menu-item" role="menuitem" tabindex="-1" data-action="${index}">
              ${icon(name)}<span>${esc(text)}</span></button>`
          })
          .join(''),
    )
    .join('')
  menuReturnFocus = document.activeElement
  menu.hidden = false
  // Where the pointer is, turned back at the window's edges the way a
  // desktop menu is.
  const box = menu.getBoundingClientRect()
  const left = x + box.width > window.innerWidth - 8 ? Math.max(8, x - box.width) : x
  const top = y + box.height > window.innerHeight - 8 ? Math.max(8, y - box.height) : y
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.style.transformOrigin = `${left < x ? 'right' : 'left'} ${top < y ? 'bottom' : 'top'}`
  menu.classList.remove('open')
  void menu.offsetWidth
  menu.classList.add('open')
  menu.querySelector('.menu-item')?.focus({ preventScroll: true })
}

function closeMenu() {
  if (menu.hidden) return
  menu.hidden = true
  menu.classList.remove('open')
  menuActions = []
  if (menuReturnFocus?.isConnected) menuReturnFocus.focus({ preventScroll: true })
  menuReturnFocus = null
}

view.addEventListener('contextmenu', (event) => {
  const sections = menuFor(event.target)
  if (!sections) return closeMenu()
  event.preventDefault()
  // From the keyboard (the menu key, Shift+F10) there is no pointer: the
  // menu opens at the row or tile that has the focus.
  if (event.clientX === 0 && event.clientY === 0) {
    const box = event.target.getBoundingClientRect()
    return openMenu(sections, box.left + 16, box.top + box.height / 2)
  }
  openMenu(sections, event.clientX, event.clientY)
})

menu.addEventListener('click', (event) => {
  const item = event.target.closest('.menu-item')
  if (!item) return
  const action = menuActions[item.dataset.action]
  closeMenu()
  action?.()
})

menu.addEventListener('contextmenu', (event) => event.preventDefault())

menu.addEventListener('keydown', (event) => {
  const items = [...menu.querySelectorAll('.menu-item')]
  const index = items.indexOf(document.activeElement)
  const move = { ArrowDown: 1, ArrowUp: -1 }[event.key]
  if (move) {
    event.preventDefault()
    items[(index + move + items.length) % items.length].focus()
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    items.at(event.key === 'Home' ? 0 : -1).focus()
  } else if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault()
    closeMenu()
  }
})

// Anywhere else closes it, and so does scrolling: a menu left where the
// pointer was would end up over something else (Beacon's menus do the same).
document.addEventListener('pointerdown', (event) => {
  if (!menu.contains(event.target)) closeMenu()
})
window.addEventListener('scroll', closeMenu, { passive: true })
window.addEventListener('resize', closeMenu)
window.addEventListener('blur', closeMenu)
window.addEventListener('hashchange', closeMenu)

// ── Events ─────────────────────────────────────────────────────────────

view.addEventListener('change', (event) => {
  const list = event.target.dataset?.sortSelect
  if (list === 'albums') {
    state.sort = event.target.value
    renderAlbums()
  } else if (list === 'songs') {
    songs.sort = event.target.value
    resetSongs()
    window.scrollTo(0, 0)
    renderSongs()
  }
})

view.addEventListener('click', async (event) => {
  const button = event.target.closest('button')
  if (!button) return
  const { dataset } = button
  if (dataset.play !== undefined) {
    await playSong(rowsOnScreen[dataset.play], dataset.mode)
  } else if (dataset.playAlbum) {
    await playAlbum(dataset.playAlbum, 'now')
  } else if (dataset.albumAction) {
    // On the album's own page, playing it needs no toast to say so.
    const mode = dataset.albumAction === 'queue' ? 'queue' : 'now'
    await playAlbum(view.dataset.album, mode, { label: mode === 'queue' })
  } else if (dataset.playArtist !== undefined) {
    await playArtist(currentPath().slice('/artist/'.length), 'now')
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
  const before = totalSongs()
  state.status = await api('status')
  if (!state.status.scanning) {
    scanBar.hidden = true
    await loadLibrary()
    const added = totalSongs() - before
    toast(added > 0 ? `Found ${plural(added, 'new song')}` : 'Up to date')
  }
  followScan()
}

async function loadLibrary() {
  const folder = state.folder
  const [albums, artists] = await Promise.all([folderApi('albums'), folderApi('artists')])
  // Another folder was picked meanwhile: its own load is on the way.
  if (folder !== state.folder) return
  state.albums = albums
  state.artists = artists
  state.albumCache.clear()
  resetSongs()
  route()
}

async function start() {
  document.getElementById('standalone').hidden = embedded
  document.body.classList.toggle('embedded', embedded)
  // First, so Beacon's colours arrive before the library does.
  if (embedded) window.parent.postMessage({ type: 'beacon.ready' }, '*')
  state.status = await api('status')
  state.folders = state.status.folders
  document.getElementById('brand').textContent = state.status.name
  document.title = state.status.name
  state.folder = parseHash().key
  await loadLibrary()
  followScan()
}

start().catch((error) => {
  view.innerHTML = `<div class="empty">Could not load the library: ${esc(error.message)}</div>`
})
