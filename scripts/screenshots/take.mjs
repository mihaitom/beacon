// Takes the README screenshots described in shots.mjs and writes them as
// WebP to docs/screenshots/.
//
//   pnpm screenshots              # every shot
//   pnpm screenshots home artist  # only these
//   SCREENSHOT_CONFIG=other.mjs pnpm screenshots  # another shots file
//
// Drives the web build in Playwright's Chromium (the same one the layout
// tests use) against connect: the one already running from `pnpm dev`, or
// one it starts itself. The app is set up through its own Pinia stores
// rather than by clicking, so a redesigned button does not break the
// script - only a renamed store action does.
//
// Login comes from connect/.env's SUBSONIC_TEST_* unless SCREENSHOT_SERVER_URL,
// SCREENSHOT_USER, SCREENSHOT_PASSWORD (and SCREENSHOT_SERVER_TYPE, default
// subsonic, or jellyfin) say otherwise.
//
// Playing a song here is real playback against that account: it can show up
// as "now playing" on the server, and the remote shot hands out a new Remote
// Control password, so a phone paired before has to pair again.
/**
 * @typedef {{ artist: string, title: string, position?: number }} SongRef
 * @typedef {{ route?: string, artist?: string, album?: string, lyrics?: boolean }} OpenTarget
 * @typedef {{ theme?: 'beacon' | 'graphite' | 'paper' | 'glacier' | 'custom',
 *   custom?: { background: string, primary: string }, adaptiveAccent?: boolean }} Theme
 * @typedef {number | string} FanartPick
 * @typedef {Record<string, FanartPick | { banner?: FanartPick, background?: FanartPick }>} FanartPicks
 * @typedef {{ name: string, device: 'desktop' | 'phone', song?: SongRef,
 *   open?: OpenTarget, remote?: boolean, settle?: number, theme?: Theme,
 *   fanart?: FanartPicks }} Shot
 * @typedef {{ outDir: string, quality: number, volume: number, settle: number,
 *   shots: Shot[] }} ScreenshotConfig
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { chromium } from 'playwright'
import { createServer } from 'vite'

// SCREENSHOT_CONFIG points at another shots file, e.g. a throwaway one to
// look at a single view.
const configUrl = process.env.SCREENSHOT_CONFIG
  ? pathToFileURL(resolve(process.env.SCREENSHOT_CONFIG)).href
  : new URL('./shots.mjs', import.meta.url).href
/** @type {ScreenshotConfig} */
const config = (await import(configUrl)).default

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// web.vite.config.ts resolves its paths against the working directory.
process.chdir(repoRoot)

// SCREENSHOT_OUT_DIR to try a change without touching the README's pictures.
const outDir = resolve(process.env.SCREENSHOT_OUT_DIR ?? config.outDir)

const appVersion = JSON.parse(await readFile('package.json', 'utf-8')).version

const connectEnv = loadDotenv({ path: 'connect/.env', processEnv: {}, quiet: true }).parsed ?? {}
const connectPort = connectEnv.PORT || '7071'
const connectUrl = `http://127.0.0.1:${connectPort}`

const credentials = {
  serverUrl: process.env.SCREENSHOT_SERVER_URL ?? connectEnv.SUBSONIC_TEST_URL,
  username: process.env.SCREENSHOT_USER ?? connectEnv.SUBSONIC_TEST_USER,
  password: process.env.SCREENSHOT_PASSWORD ?? connectEnv.SUBSONIC_TEST_PASSWORD,
  serverType: process.env.SCREENSHOT_SERVER_TYPE ?? 'subsonic',
}

// The phone is an iPhone-sized screen at its real pixel density, so the
// pictures stay sharp next to the desktop ones in the README.
const DEVICES = {
  desktop: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
  phone: {
    viewport: { width: 393, height: 700 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
}

async function connectIsUp() {
  try {
    // Any answer counts: with a CONNECT_TOKEN set, /health is a 401 here.
    await fetch(`${connectUrl}/health`)
    return true
  } catch {
    return false
  }
}

/** Starts connect unless one is already listening; returns a stop function. */
async function ensureConnect() {
  if (await connectIsUp()) return () => {}
  console.log(`connect is not running on ${connectPort}, starting it`)
  const child = spawn('uv', ['run', 'python', 'main.py'], {
    cwd: 'connect',
    stdio: 'ignore',
    detached: true,
  })
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  // It runs in its own process group, so nothing takes it down with the
  // script: a crash or Ctrl+C would leave it holding the port that
  // `pnpm dev` needs. 'exit' covers a crash; the signals have to be turned
  // into an exit first.
  process.on('exit', stop)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130))
  for (let waited = 0; waited < 60_000; waited += 500) {
    if (await connectIsUp()) return stop
    await new Promise((done) => setTimeout(done, 500))
  }
  stop()
  throw new Error('connect did not come up within 60 s')
}

// --- in-page steps -----------------------------------------------------
// These run inside the app. Vite serves the source modules under /src/, and
// importing one again returns the instance the app already uses.

async function inPageLogin(creds) {
  const { useAuthStore } = await import('/src/stores/auth.ts')
  await useAuthStore().login(creds)
  const router = (await import('/src/router/index.ts')).default
  await router.replace('/')
}

async function inPagePlay({ song, volume }) {
  const { useLibraryStore } = await import('/src/stores/library.ts')
  const { usePlaybackStore } = await import('/src/stores/playback.ts')
  const client = useLibraryStore().client()
  const norm = (text) =>
    (text ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()

  let candidates = []
  let match
  for (const query of [norm(song.title), `${norm(song.artist)} ${norm(song.title)}`]) {
    candidates = (await client.search3(query, 100, 0, 0)).songs
    match = candidates.find(
      (s) =>
        norm(s.artist).includes(norm(song.artist)) && norm(s.title).startsWith(norm(song.title)),
    )
    if (match) break
  }
  if (!match) {
    // A misspelt title finds nothing at all; the artist's own songs then
    // show what it is called.
    if (!candidates.length) candidates = (await client.search3(norm(song.artist), 30, 0, 0)).songs
    const seen = candidates.slice(0, 30).map((s) => `${s.artist} - ${s.title}`)
    throw new Error(
      `No song "${song.artist} - ${song.title}". Found: ${seen.join('; ') || 'nothing'}`,
    )
  }

  if (match.duration && (song.position ?? 0) >= match.duration) {
    throw new Error(`position ${song.position} s is past the end of the song (${match.duration} s)`)
  }

  // The rest of its album after it, so the queue and the next button look
  // like a real session instead of a single-song queue.
  let queue = [match]
  if (match.albumId) {
    const { songs } = await client.getAlbum(match.albumId)
    const at = songs.findIndex((s) => s.id === match.id)
    if (at >= 0) queue = [...songs.slice(at), ...songs.slice(0, at)]
  }

  const playback = usePlaybackStore()
  playback.setVolume(volume)
  playback.setQueue(queue, 0)
  await playback.startCurrent(song.position ?? 0)
  window.__screenshotPlayback = playback
  return `${match.artist} - ${match.title}`
}

async function inPageOpen({ open, phone }) {
  if (open.lyrics) {
    const { useDrawersStore } = await import('/src/stores/drawers.ts')
    useDrawersStore().lyricsPanelOpen = true
  }
  const router = (await import('/src/router/index.ts')).default
  if (open.route) return router.push(open.route)

  const { useLibraryStore } = await import('/src/stores/library.ts')
  const client = useLibraryStore().client()
  const prefix = phone ? '/m' : ''
  const kind = open.artist ? 'artist' : 'album'
  const wanted = (open.artist ?? open.album).toLowerCase()
  const found = await client.search3(
    wanted,
    0,
    kind === 'album' ? 20 : 0,
    kind === 'artist' ? 20 : 0,
  )
  const list = kind === 'artist' ? found.artists : found.albums
  const hit = list.find((item) => item.name.toLowerCase() === wanted) ?? list[0]
  if (!hit) throw new Error(`No ${kind} "${wanted}" on the server`)
  return router.push(`${prefix}/${kind}s/${hit.id}`)
}

async function inPageEnableRemote() {
  const { useRemoteControlStore } = await import('/src/stores/remoteControl.ts')
  const remote = useRemoteControlStore()
  await remote.enable()
  return remote.password
}

/** PNG -> WebP with Chromium's own encoder, so there is nothing to install. */
async function inPageToWebp({ png, quality }) {
  const blob = await (await fetch(`data:image/png;base64,${png}`)).blob()
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  const webp = await canvas.convertToBlob({ type: 'image/webp', quality })
  if (webp.type !== 'image/webp') throw new Error('This Chromium cannot encode WebP')
  return await new Promise((done) => {
    const reader = new FileReader()
    reader.onload = () => done(String(reader.result).split(',')[1])
    reader.readAsDataURL(webp)
  })
}

// --- driver --------------------------------------------------------------

/** The theme, as Settings stores it on the device - read before the app
 * mounts, so the first frame is already in it. */
async function presetTheme(context, theme) {
  if (!theme) return
  await context.addInitScript((value) => {
    localStorage.setItem('beacon.theme', JSON.stringify(value))
  }, theme)
}

/** Which of `urls` a pick means: a position in the list (1 is Fanart.tv's
 * best) or a piece of the image's URL. */
function pickFrom(urls, pick, label) {
  if (pick === undefined) return undefined
  const url = typeof pick === 'number' ? urls[pick - 1] : urls.find((u) => u.includes(pick))
  if (!url) console.warn(`  fanart: ${JSON.stringify(pick)} matches none of the ${label}`)
  return url
}

function printChoices(label, urls, chosen) {
  if (!urls.length) return
  console.log(`  fanart ${label}:`)
  urls.forEach((url, index) =>
    console.log(`    ${url === chosen ? '*' : ' '} ${index + 1}  ${url}`),
  )
}

/** The pick for the artist the app asks about. A credit with a guest
 * ("Armand van Helden & Hitty") is looked up under its first artist, so a
 * pick for that artist applies to it too. */
function picksFor(picks, name) {
  const asked = name.toLowerCase()
  const keys = Object.keys(picks)
  const key =
    keys.find((artist) => artist.toLowerCase() === asked) ??
    keys.find((artist) => asked.startsWith(`${artist.toLowerCase()} `))
  const pick = key === undefined ? undefined : picks[key]
  // A bare number or string is the background, the common case.
  return typeof pick === 'object' ? pick : { background: pick }
}

/** connect picks an artist's Fanart.tv banner (Home's hero) and background
 * (artist page, Now Playing) at random; this rewrites its answer so they are
 * the ones in `picks`. Every artist's candidates are printed, to choose
 * from. */
async function pinFanart(context, picks) {
  const listed = new Set()
  await context.route(/\/fanart\/artist\?/, async (route) => {
    let response
    try {
      response = await route.fetch()
    } catch {
      // The shot is over and its browser closed while this was on its way.
      return
    }
    const body = await response.json()
    const art = body.art
    const name = new URL(route.request().url()).searchParams.get('name') ?? ''
    if (!art) return route.fulfill({ response, json: body })

    const pick = picksFor(picks, name)
    if (pick.banner !== undefined && !art.banners) {
      console.warn('  fanart: connect sends no banner list - restart it to pick a banner')
    }
    const banners = art.banners ?? []
    const backgrounds = art.backgrounds ?? []
    art.banner = pickFrom(banners, pick.banner, `banners of ${name}`) ?? art.banner
    art.background =
      pickFrom(backgrounds, pick.background, `backgrounds of ${name}`) ?? art.background

    if (!listed.has(name)) {
      listed.add(name)
      printChoices(`banners for ${name}`, banners, art.banner)
      printChoices(`backgrounds for ${name}`, backgrounds, art.background)
    }
    return route.fulfill({ response, json: body })
  })
}

/** A fresh browser is a first start: keep it from looking like one. */
async function quietFirstStart(context) {
  // The release notes open once per version; the app moves this key under
  // the account on login.
  await context.addInitScript((version) => {
    localStorage.setItem(`beacon.releaseNotesSeen:${version}`, version)
  }, appVersion)
  // The server's play queue stays out of it both ways: reading it offers
  // "continue where you left off", and saving would overwrite the queue the
  // account's other devices carry on with.
  await context.route(/\/rest\/(get|save)PlayQueue/, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1' } }),
    }),
  )
}

async function openApp(browser, appUrl, device, shot) {
  const context = await browser.newContext({ ...DEVICES[device], locale: 'en-US' })
  await quietFirstStart(context)
  await presetTheme(context, shot.theme)
  await pinFanart(context, shot.fanart ?? {})
  const page = await context.newPage()
  page.on('pageerror', (error) => console.warn(`  page error: ${error.message}`))
  await page.goto(appUrl)
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__)
  await page.evaluate(inPageLogin, credentials)
  return { context, page }
}

async function startSong(page, song) {
  const label = await page.evaluate(inPagePlay, { song, volume: config.volume })
  console.log(`  playing ${label}`)
  await page.waitForFunction(
    () => window.__screenshotPlayback?.isPlaying && window.__screenshotPlayback.localPosition > 0,
    null,
    { timeout: 30_000 },
  )
}

async function takeShot(browser, appUrl, shot) {
  const contexts = []
  try {
    // The remote shot needs a desktop Beacon to steer; the phone only
    // shows what that one is playing.
    const app = await openApp(browser, appUrl, shot.remote ? 'desktop' : shot.device, shot)
    contexts.push(app.context)
    if (shot.song) await startSong(app.page, shot.song)

    let target = app.page
    if (shot.remote) {
      const password = await app.page.evaluate(inPageEnableRemote)
      const phone = await browser.newContext({ ...DEVICES[shot.device], locale: 'en-US' })
      contexts.push(phone)
      await phone.addInitScript((value) => {
        localStorage.setItem('beacon_remote_password', value)
      }, password)
      target = await phone.newPage()
      await target.goto(`${connectUrl}/remote/app/`)
    } else if (shot.open) {
      await app.page.evaluate(inPageOpen, { open: shot.open, phone: shot.device === 'phone' })
    }

    await target.waitForTimeout(shot.settle ?? config.settle)
    const png = (await target.screenshot({ type: 'png' })).toString('base64')
    const webp = await target.evaluate(inPageToWebp, { png, quality: config.quality })
    const file = resolve(outDir, `${shot.name}.webp`)
    await writeFile(file, Buffer.from(webp, 'base64'))
    console.log(`  wrote ${file}`)
  } finally {
    for (const context of contexts) {
      // A request still being rewritten (pinFanart) would otherwise fail
      // the whole run once its context is gone.
      await context.unrouteAll({ behavior: 'ignoreErrors' })
      await context.close()
    }
  }
}

async function main() {
  if (!credentials.serverUrl || !credentials.username) {
    throw new Error(
      'No login: set SUBSONIC_TEST_* in connect/.env or SCREENSHOT_* in the environment',
    )
  }
  const only = process.argv.slice(2)
  const shots = only.length ? config.shots.filter((s) => only.includes(s.name)) : config.shots
  const unknown = only.filter((name) => !config.shots.some((s) => s.name === name))
  if (unknown.length) throw new Error(`Unknown shot(s): ${unknown.join(', ')}`)

  await mkdir(outDir, { recursive: true })
  const stopConnect = await ensureConnect()
  const vite = await createServer({
    configFile: resolve('web.vite.config.ts'),
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: 5274, strictPort: false, hmr: false },
  })
  await vite.listen()
  const appUrl = vite.resolvedUrls.local[0]
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  })

  let failed = 0
  try {
    for (const shot of shots) {
      console.log(shot.name)
      try {
        await takeShot(browser, appUrl, shot)
      } catch (error) {
        failed++
        console.error(`  failed: ${error.message}`)
      }
    }
  } finally {
    await browser.close()
    await vite.close()
    stopConnect()
  }
  if (failed) process.exitCode = 1
}

await main()
