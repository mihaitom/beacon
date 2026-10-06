import { describe, expect, it } from 'vitest'
import dockerfile from '../../../../../../Dockerfile?raw'
import { HELP_DOCS, HELP_PAGES, pageFor, renderHelpPage, resolveLink, slugify } from '../docs'

const REPO = 'https://github.com/mihaitom/beacon'

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

describe('slugify', () => {
  it('makes the anchors GitHub makes, so existing links keep working', () => {
    expect(slugify('No devices found')).toBe('no-devices-found')
    expect(slugify('Traefik + Authentik')).toBe('traefik--authentik')
    expect(slugify("Why don't OS media keys / lock screen controls work while casting?")).toBe(
      'why-dont-os-media-keys--lock-screen-controls-work-while-casting',
    )
    expect(slugify('A. A library track, played in this app')).toBe(
      'a-a-library-track-played-in-this-app',
    )
  })
})

describe('resolveLink', () => {
  it('keeps an anchor in the same doc', () => {
    expect(resolveLink('#client-addresses', 'party-mode.md')).toEqual({
      kind: 'anchor',
      anchor: 'client-addresses',
    })
  })

  it('opens another bundled doc in the dialog, at its heading', () => {
    expect(resolveLink('party-mode.md#over-the-internet', 'faq.md')).toEqual({
      kind: 'doc',
      id: 'party-mode',
      anchor: 'over-the-internet',
    })
    expect(resolveLink('faq.md', 'party-mode.md')).toEqual({
      kind: 'doc',
      id: 'faq',
      anchor: null,
    })
  })

  it('sends everything not bundled to the repository on GitHub', () => {
    expect(resolveLink('investigations/radio-visualizer-cast-sync.md', 'faq.md')).toEqual({
      kind: 'external',
      url: `${REPO}/blob/main/docs/investigations/radio-visualizer-cast-sync.md`,
    })
    expect(resolveLink('../build/ffmpeg/README.md', 'faq.md')).toEqual({
      kind: 'external',
      url: `${REPO}/blob/main/build/ffmpeg/README.md`,
    })
    // A folder is a tree on GitHub, not a blob.
    expect(resolveLink('../home-assistant/', 'home-automation.md')).toEqual({
      kind: 'external',
      url: `${REPO}/tree/main/home-assistant/`,
    })
  })

  it('leaves a full URL alone', () => {
    expect(resolveLink('https://example.com/x', 'faq.md')).toEqual({
      kind: 'external',
      url: 'https://example.com/x',
    })
  })
})

describe('the bundled docs', () => {
  const rendered = new Map(HELP_PAGES.map((page) => [page.id, parse(renderHelpPage(page))]))

  it('each have a title', () => {
    for (const doc of HELP_DOCS) expect(doc.title, doc.file).not.toBe('')
    for (const page of HELP_PAGES) expect(page.title, page.id).not.toBe('')
  })

  it('find the FAQ topic that holds a question', () => {
    for (const page of HELP_PAGES) {
      for (const anchor of page.anchors) {
        expect(pageFor(page.doc, anchor).id, `${page.id}#${anchor}`).toBe(page.id)
      }
    }
  })

  // The one that breaks quietly: a heading renamed in one doc, a link to it
  // left behind in another.
  it('only link to headings that exist', () => {
    for (const [id, page] of rendered) {
      for (const link of page.querySelectorAll<HTMLAnchorElement>('a[data-help-page]')) {
        const anchor = link.dataset.helpAnchor
        if (!anchor) continue
        const target = rendered.get(link.dataset.helpPage!)!
        expect(
          target.getElementById(anchor),
          `${id}: ${link.textContent} -> ${link.dataset.helpPage}#${anchor}`,
        ).not.toBeNull()
      }
    }
  })

  it('open everything outside the dialog in a new window', () => {
    for (const page of rendered.values()) {
      for (const link of page.querySelectorAll<HTMLAnchorElement>('a:not([data-help-page])')) {
        expect(link.target).toBe('_blank')
        expect(link.rel).toContain('noopener')
      }
    }
  })

  // The web image copies docs/ file by file; one left out there only
  // breaks the Docker build.
  it('are all copied into the Docker build', () => {
    for (const doc of HELP_DOCS) expect(dockerfile, doc.file).toContain(`docs/${doc.file}`)
  })
})
