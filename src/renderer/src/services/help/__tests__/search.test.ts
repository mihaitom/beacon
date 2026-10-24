import { describe, expect, it } from 'vitest'
import { findHelpPage, pageFor } from '../docs'
import { helpSections, highlightRuns, searchHelp, snippetFor, tableOfContents } from '../search'

describe('helpSections', () => {
  it('cuts a page at its headings, with the ids the dialog scrolls to', () => {
    const page = pageFor('faq', 'no-devices-found')
    const section = helpSections(page).find((s) => s.anchor === 'no-devices-found')!
    expect(section.heading).toBe('No devices found')
    expect(section.text).toMatch(/network_mode: host/)
    // Only its own text, not the next question's.
    expect(section.text).not.toMatch(/MFi/)
  })

  it("gives a tab's text to its tab, although the tabs come before the panels", () => {
    const sections = helpSections(findHelpPage('guides/party-over-the-internet'))
    const authelia = sections.find((s) => s.heading === 'Authelia')!
    const caddy = sections.find((s) => s.heading === 'Caddy')!
    expect(authelia.text).toMatch(/Authelia/)
    expect(caddy.text).toMatch(/@party path/)
    expect(caddy.text).not.toMatch(/Authelia waves/)
  })
})

describe('tableOfContents', () => {
  it("lists a FAQ topic's questions in order", () => {
    const page = pageFor('faq', 'no-devices-found')
    const entries = tableOfContents(page).map((s) => s.anchor)
    expect(entries).toContain('no-devices-found')
    expect(entries.indexOf('no-devices-found')).toBeLessThan(
      entries.indexOf('my-sonos-speaker-doesnt-appear-under-airplay-or-dlna'),
    )
  })

  it('leaves out subsections, which would crowd the column', () => {
    const entries = tableOfContents(findHelpPage('guides/party-over-the-internet')).map(
      (s) => s.heading,
    )
    expect(entries).toContain('Example setups')
    expect(entries).not.toContain('Caddy')
  })
})

describe('searchHelp', () => {
  it('finds a question by words of its heading, first', () => {
    const [first] = searchHelp('devices found')
    expect(first!.section.anchor).toBe('no-devices-found')
  })

  it('finds text that is only in the body, across pages', () => {
    const results = searchHelp('TRUSTED_PROXIES')
    expect(results.some((r) => r.section.page === 'guides/party-over-the-internet')).toBe(true)
  })

  it('needs every word somewhere in the section', () => {
    expect(searchHelp('sonos xyzzyplugh')).toEqual([])
  })

  it('still finds a long word typed with a mistake', () => {
    expect(searchHelp('chromecsat').length).toBeGreaterThan(0)
  })

  it('finds nothing for an empty query', () => {
    expect(searchHelp('   ')).toEqual([])
  })
})

describe('snippetFor', () => {
  const text = `${'word '.repeat(60)}the needle sits here ${'tail '.repeat(60)}`.trim()

  it('shows the text around the first hit, cut at words', () => {
    const snippet = snippetFor(text, 'needle')
    expect(snippet).toMatch(/^… /)
    expect(snippet).toMatch(/ …$/)
    expect(snippet).toContain('the needle sits here')
    expect(snippet).not.toMatch(/… \S*wor$|^… ord/)
  })

  it('starts at the beginning when the text has no hit', () => {
    expect(snippetFor('short text', 'heading')).toBe('short text')
  })
})

describe('highlightRuns', () => {
  it('marks every query word, whatever its case', () => {
    expect(highlightRuns('Sonos and the sonos app', 'SONOS')).toEqual([
      { text: 'Sonos', hit: true },
      { text: ' and the ', hit: false },
      { text: 'sonos', hit: true },
      { text: ' app', hit: false },
    ])
  })

  it('ignores punctuation in the query, as the search does', () => {
    expect(highlightRuns('a (b) c', '(b')).toEqual([
      { text: 'a (', hit: false },
      { text: 'b', hit: true },
      { text: ') c', hit: false },
    ])
  })
})
