// Samples every cached Fanart.tv background the way DetailPageBackdrop.vue
// does - through the app's own services/edgeFill.ts, inside Electron, since
// Chromium's canvas downscaling differs between builds and GPUs, and what
// the app sees is what the labels are about.
//
//   pnpm exec electron scripts/edge-fill/sample.mjs
//
// Reads connect's fanart cache (connect/, or CONNECT_DATA_DIR) and writes
// scripts/edge-fill/.cache/samples.json for review.py.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const dataDir = process.env.CONNECT_DATA_DIR || join(root, 'connect')
const out = join(here, '.cache', 'samples.json')

function backgrounds() {
  const cache = JSON.parse(readFileSync(join(dataDir, 'fanart_cache.json'), 'utf8'))
  const urls = new Set()
  for (const entry of Object.values(cache)) {
    for (const url of entry?.art?.background ?? []) urls.add(url)
  }
  return [...urls]
    .map((url) => createHash('sha256').update(url).digest('hex'))
    .filter((id) => existsSync(join(dataDir, 'fanart_images', id)))
    .sort()
}

const source = readFileSync(join(root, 'src/renderer/src/services/edgeFill.ts'), 'utf8')
const edgeFill = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false })
  await window.loadURL('data:text/html,<!doctype html>')
  await window.webContents.executeJavaScript(
    `import('data:text/javascript;base64,${Buffer.from(edgeFill).toString('base64')}')
      .then((module) => { window.EF = module })`,
  )
  const ids = backgrounds()
  const samples = []
  for (const [n, id] of ids.entries()) {
    const image = readFileSync(join(dataDir, 'fanart_images', id)).toString('base64')
    const sampled = await window.webContents.executeJavaScript(`(async () => {
      const url = 'data:image/jpeg;base64,${image}'
      const result = []
      for (const [frame, shape] of [['page', EF.PHOTO_FRAME], ['banded', EF.BANDED_PHOTO_FRAME]]) {
        const px = await EF.samplePixels(url, shape, EF.EDGE_EXTENT)
        if (!px) return null
        result.push({
          frame,
          px: btoa(String.fromCharCode(...px)),
          ...EF.leftEdgeFillFromPixels(px, EF.SAMPLE_WIDTH, EF.SAMPLE_HEIGHT, EF.EDGE_EXTENT),
        })
      }
      return result
    })()`)
    for (const sample of sampled ?? []) samples.push({ id, ...sample })
    if (n % 50 === 0) console.log(`${n}/${ids.length}`)
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ width: 64, height: 16, samples }))
  console.log(`${samples.length} samples from ${ids.length} images -> ${out}`)
  app.quit()
})
