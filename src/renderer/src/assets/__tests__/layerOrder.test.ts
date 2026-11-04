// The cascade-layer order is declared three times: in base.css, and inline
// at the top of both index.html files, where it is the copy that actually
// decides (the production build links Vuetify's shared CSS chunks ahead of
// base.css). If the copies drift apart, the reset's `margin: 0` wins over
// Vuetify's own margins in the built app only - containers lose their
// centring and sliders their spacing, while dev looks fine.
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../../../..')

function layerOrder(text: string): string[] {
  const match = text.match(/@layer\s+([a-z-]+(?:\s*,\s*[a-z-]+)+)\s*;/)
  expect(match, 'no @layer order statement found').not.toBeNull()
  return match![1]!.split(',').map((name) => name.trim())
}

describe('cascade layer order', () => {
  const fromBaseCss = layerOrder(
    readFileSync(resolve(root, 'src/renderer/src/assets/base.css'), 'utf-8'),
  )

  it('puts the reset below every Vuetify layer', () => {
    expect(fromBaseCss[0]).toBe('base')
  })

  for (const html of ['src/renderer/index.html', 'src/renderer/party/index.html']) {
    it(`is declared inline in ${html}, matching base.css`, () => {
      const text = readFileSync(resolve(root, html), 'utf-8')
      const head = text.slice(0, text.indexOf('</head>'))
      expect(layerOrder(head)).toEqual(fromBaseCss)
    })
  }
})
