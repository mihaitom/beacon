// Renders docs/styleguide.html to PNG and PDF, for when the style guide has
// to leave the repo - a review, a print, a message to someone who is not
// going to open a browser at a file:// path.
//
// Deliberately not part of any build: the HTML page is the artefact that
// stays current (it loads the app's own base.css), and a PNG committed next
// to it would start drifting the moment someone changes a colour. Run it
// when you need the picture, then throw the picture away.
//
//   node scripts/render-styleguide.mjs [outDir]
//
// Uses the Playwright that is already here for the layout tests, so there is
// nothing extra to install.
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(process.argv[2] ?? resolve(repoRoot, 'dist/styleguide'))
const page_ = pathToFileURL(resolve(repoRoot, 'docs/styleguide.html')).href

await mkdir(outDir, { recursive: true })

const browser = await chromium.launch()
// deviceScaleFactor 2 so the PNG survives being looked at on a retina screen
// or zoomed into; the page itself is 880px of content in a 1100px window.
const page = await browser.newPage({
  viewport: { width: 1100, height: 1400 },
  deviceScaleFactor: 2,
})
await page.goto(page_)
// The stand-in artwork is drawn on a canvas after load.
await page.waitForTimeout(300)

await page.screenshot({ path: resolve(outDir, 'styleguide.png'), fullPage: true })
// printBackground, or the whole thing prints as black text on white paper -
// which for a dark-theme style guide would be a picture of a different app.
await page.pdf({
  path: resolve(outDir, 'styleguide.pdf'),
  printBackground: true,
  width: '1100px',
  height: '1400px',
})

await browser.close()
console.log(`Wrote styleguide.png and styleguide.pdf to ${outDir}`)
