import { describe, expect, it } from 'vitest'
import dockerfile from '../../../../../../Dockerfile?raw'
import readme from '../../../../../../README.md?raw'
import dockerignore from '../../../../../../.dockerignore?raw'
import {
  FEATURES_PAGE,
  HELP_DOCS,
  HELP_PAGES,
  pageFor,
  renderHelpPage,
  resolveLink,
  slugify,
} from '../docs'

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
    expect(resolveLink('#client-addresses', 'docs/party-mode.md')).toEqual({
      kind: 'anchor',
      anchor: 'client-addresses',
    })
  })

  it('opens another bundled doc in the dialog, at its heading', () => {
    expect(resolveLink('party-mode.md#over-the-internet', 'docs/faq.md')).toEqual({
      kind: 'doc',
      id: 'party-mode',
      anchor: 'over-the-internet',
    })
    expect(resolveLink('faq.md', 'docs/party-mode.md')).toEqual({
      kind: 'doc',
      id: 'faq',
      anchor: null,
    })
  })

  it('sends everything not bundled to the repository on GitHub', () => {
    expect(resolveLink('investigations/radio-visualizer-cast-sync.md', 'docs/faq.md')).toEqual({
      kind: 'external',
      url: `${REPO}/blob/main/docs/investigations/radio-visualizer-cast-sync.md`,
    })
    expect(resolveLink('../build/ffmpeg/README.md', 'docs/faq.md')).toEqual({
      kind: 'external',
      url: `${REPO}/blob/main/build/ffmpeg/README.md`,
    })
    // A folder is a tree on GitHub, not a blob.
    expect(resolveLink('../home-assistant/', 'docs/home-automation.md')).toEqual({
      kind: 'external',
      url: `${REPO}/tree/main/home-assistant/`,
    })
  })

  it('resolves a link in the README from the repository root', () => {
    expect(resolveLink('docs/party-mode.md', 'README.md')).toEqual({
      kind: 'doc',
      id: 'party-mode',
      anchor: null,
    })
    expect(resolveLink('home-assistant/', 'README.md')).toEqual({
      kind: 'external',
      url: `${REPO}/tree/main/home-assistant/`,
    })
  })

  it('leaves a full URL alone', () => {
    expect(resolveLink('https://example.com/x', 'docs/faq.md')).toEqual({
      kind: 'external',
      url: 'https://example.com/x',
    })
  })
})

describe('the bundled docs', () => {
  const rendered = new Map(
    [...HELP_PAGES, FEATURES_PAGE].map((page) => [page.id, parse(renderHelpPage(page))]),
  )

  it('each have a title', () => {
    for (const doc of HELP_DOCS) expect(doc.title, doc.path).not.toBe('')
    for (const page of HELP_PAGES) expect(page.title, page.id).not.toBe('')
  })

  it('find the FAQ topic that holds a question', () => {
    for (const page of HELP_PAGES) {
      for (const anchor of page.anchors) {
        expect(pageFor(page.doc!, anchor).id, `${page.id}#${anchor}`).toBe(page.id)
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

  // The web image copies docs/ file by file; one left out there, or
  // filtered out again by .dockerignore, only breaks the Docker build.
  it('are all copied into the Docker build', () => {
    const ignored = dockerignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    for (const path of [...HELP_DOCS.map((doc) => doc.path), 'README.md']) {
      expect(dockerfile, path).toMatch(new RegExp(`^COPY .*\\b${path.replace('.', '\\.')}\\b`, 'm'))
      expect(ignored, path).not.toContain(path)
      expect(ignored, path).not.toContain(path.split('/')[0])
    }
  })
})

describe('FEATURES_PAGE', () => {
  it("is the README's Features section with its subsections, and nothing after it", () => {
    expect(FEATURES_PAGE.body).toMatch(/^- \*\*/m)
    expect(FEATURES_PAGE.body).not.toMatch(/^## /m)
    expect(FEATURES_PAGE.anchors.size).toBeGreaterThan(0)
  })

  it('leaves out the keyboard shortcuts, which have a dialog of their own', () => {
    const features = readme.slice(readme.search(/^## Features$/m) + 1)
    const subsections = [...features.slice(0, features.search(/^## /m)).matchAll(/^### (.+)$/gm)]
    const kept = subsections.map((m) => slugify(m[1]!)).filter((id) => id !== 'keyboard-shortcuts')
    expect(FEATURES_PAGE.anchors).not.toContain('keyboard-shortcuts')
    expect(kept.length).toBeGreaterThan(0)
    for (const id of kept) expect(FEATURES_PAGE.anchors, id).toContain(id)
  })

  it('opens the bundled docs it links to in the help dialog', () => {
    const page = new DOMParser().parseFromString(renderHelpPage(FEATURES_PAGE), 'text/html')
    const inApp = [...page.querySelectorAll<HTMLAnchorElement>('a[data-help-page]')]
    expect(inApp.map((link) => link.dataset.helpPage)).toContain('party-mode')
  })
})

describe('tabbed sections', () => {
  const page = parse(renderHelpPage(pageFor('party-mode')))
  const group = page.querySelector('.help-tabs')!

  it('show each reverse proxy setup as a tab, the first one open', () => {
    const tabs = [...group.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs.map((tab) => tab.textContent)).toContain('Authelia')
    const panels = [...group.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
    expect(panels).toHaveLength(tabs.length)
    expect(panels[0]!.hidden).toBe(false)
    expect(panels.slice(1).every((panel) => panel.hidden)).toBe(true)
  })

  it('keep the ids GitHub gives those headings, so links to them still work', () => {
    const tab = page.getElementById(slugify('Traefik (file provider)'))
    expect(tab?.getAttribute('role')).toBe('tab')
    expect(pageFor('party-mode').anchors.has(slugify('Traefik (file provider)'))).toBe(true)
  })

  it('keep a code block whole, lines in it that look like headings included', () => {
    const body = [
      '### Example setups',
      '',
      '#### First',
      '',
      '```',
      '## not a heading',
      '#### nor this',
      '```',
      '',
      '#### Second',
      '',
      'Text.',
    ].join('\n')
    const own = parse(renderHelpPage({ ...pageFor('party-mode'), body }))
    expect([...own.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'First',
      'Second',
    ])
    expect(own.getElementById('first-panel')!.querySelector('pre')!.textContent).toContain(
      '#### nor this',
    )
  })

  it('leave what follows the section as it was', () => {
    expect(page.getElementById('client-addresses')?.closest('.help-tabs')).toBeNull()
  })
})
