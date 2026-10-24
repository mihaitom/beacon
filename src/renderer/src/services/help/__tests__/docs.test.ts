import { describe, expect, it } from 'vitest'
import dockerfile from '../../../../../../Dockerfile?raw'
import dockerignore from '../../../../../../.dockerignore?raw'
import {
  FEATURES_PAGE,
  HELP_PAGES,
  isFaqPage,
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
    expect(resolveLink('#client-addresses', 'docs/help/party-mode.md')).toEqual({
      kind: 'anchor',
      anchor: 'client-addresses',
    })
  })

  it('opens another bundled doc in the dialog, at its heading', () => {
    expect(resolveLink('../party-mode.md#over-the-internet', 'docs/help/faq/privacy.md')).toEqual({
      kind: 'doc',
      id: 'party-mode',
      anchor: 'over-the-internet',
    })
    expect(resolveLink('faq/library.md', 'docs/help/features.md')).toEqual({
      kind: 'doc',
      id: 'faq/library',
      anchor: null,
    })
  })

  it('sends everything not bundled to the repository on GitHub', () => {
    expect(
      resolveLink(
        '../../investigations/radio-visualizer-cast-sync.md',
        'docs/help/faq/playback.md',
      ),
    ).toEqual({
      kind: 'external',
      url: `${REPO}/blob/main/docs/investigations/radio-visualizer-cast-sync.md`,
    })
    expect(resolveLink('../../../build/ffmpeg/README.md', 'docs/help/faq/formats.md')).toEqual({
      kind: 'external',
      url: `${REPO}/blob/main/build/ffmpeg/README.md`,
    })
    // A folder is a tree on GitHub, not a blob.
    expect(resolveLink('../../home-assistant/', 'docs/help/home-automation.md')).toEqual({
      kind: 'external',
      url: `${REPO}/tree/main/home-assistant/`,
    })
  })

  it('leaves a full URL alone', () => {
    expect(resolveLink('https://example.com/x', 'docs/help/faq/privacy.md')).toEqual({
      kind: 'external',
      url: 'https://example.com/x',
    })
  })
})

describe('the bundled docs', () => {
  const rendered = new Map(HELP_PAGES.map((page) => [page.id, parse(renderHelpPage(page))]))

  it('are every file under docs/help/, the FAQ one page per topic', () => {
    expect(HELP_PAGES.map((page) => page.id)).toContain('party-mode')
    expect(HELP_PAGES.filter(isFaqPage).length).toBeGreaterThan(1)
    expect(FEATURES_PAGE.id).toBe('features')
  })

  it('each have a title, and show neither front matter nor markers as text', () => {
    for (const page of HELP_PAGES) {
      expect(page.title, page.id).not.toBe('')
      expect(page.body, page.id).not.toMatch(/^---/)
      expect(rendered.get(page.id)!.body.textContent, page.id).not.toContain('<!--')
    }
  })

  it('come in the order their front matter gives', () => {
    const faq = HELP_PAGES.filter(isFaqPage)
    const orders = faq.map((page) => page.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
    expect(orders.every(Number.isFinite)).toBe(true)
  })

  it('find the FAQ topic that holds a question', () => {
    for (const page of HELP_PAGES.filter(isFaqPage)) {
      for (const anchor of page.anchors) {
        expect(pageFor('faq', anchor).id, `${page.id}#${anchor}`).toBe(page.id)
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

  // Left out there, or filtered out again by .dockerignore, the help only
  // breaks in the Docker build.
  it('are copied into the Docker build', () => {
    const ignored = dockerignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    expect(dockerfile).toMatch(/^COPY docs\/help\b/m)
    for (const path of ['docs', 'docs/help', 'docs/help/']) expect(ignored).not.toContain(path)
  })

  it('link from the features page to the other docs inside the dialog', () => {
    const inApp = [
      ...rendered.get('features')!.querySelectorAll<HTMLAnchorElement>('a[data-help-page]'),
    ]
    expect(inApp.map((link) => link.dataset.helpPage)).toContain('party-mode')
  })
})

describe('tab groups', () => {
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

  function render(lines: string[]): Document {
    return parse(renderHelpPage({ ...pageFor('party-mode'), body: lines.join('\n') }))
  }

  it("start a tab only at headings of the first one's level", () => {
    const own = render([
      '<!-- tabs -->',
      '#### First',
      '##### Inside the first',
      '#### Second',
      '<!-- /tabs -->',
    ])
    expect([...own.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'First',
      'Second',
    ])
    expect(own.getElementById('first-panel')!.querySelector('h5')).not.toBeNull()
  })

  it('keep a code block whole, lines in it that look like headings or markers included', () => {
    const own = render([
      '<!-- tabs -->',
      '',
      '#### First',
      '',
      '```',
      '## not a heading',
      '<!-- /tabs -->',
      '```',
      '',
      '#### Second',
      '',
      'Text.',
      '<!-- /tabs -->',
    ])
    expect([...own.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'First',
      'Second',
    ])
    expect(own.getElementById('first-panel')!.querySelector('pre')!.textContent).toContain(
      '## not a heading',
    )
  })

  it('leave what follows the group as it was', () => {
    expect(page.getElementById('client-addresses')?.closest('.help-tabs')).toBeNull()
  })
})
