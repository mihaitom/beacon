import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchUpcoming, parseChangelog, unreleasedSection, upcomingFrom } from '../changelog'

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

### Added

- Something new

## [1.10.0] - 2026-10-20

### Fixed

- A fix

## [1.9.0] - 2026-10-15

- Older

## [1.8.0] - 2026-10-13

- Oldest
`

describe('parseChangelog', () => {
  it('keeps the released sections and leaves out Unreleased', () => {
    const entries = parseChangelog(CHANGELOG)
    expect(entries.map((entry) => entry.version)).toEqual(['1.10.0', '1.9.0', '1.8.0'])
    expect(entries[0]).toMatchObject({ date: '2026-10-20', body: '### Fixed\n\n- A fix' })
  })

  it('does not run the Unreleased section into the release before it', () => {
    const changelog = '## [1.0.0] - 2026-01-01\n\n- Released\n\n## [Unreleased]\n\n- Not yet\n'
    expect(parseChangelog(changelog)[0]?.body).toBe('- Released')
  })
})

describe('unreleasedSection', () => {
  it('is the section up to the next heading', () => {
    expect(unreleasedSection(CHANGELOG)).toBe('### Added\n\n- Something new')
  })

  it('is empty without one', () => {
    expect(unreleasedSection('## [1.0.0] - 2026-01-01\n\n- Released')).toBe('')
  })
})

describe('upcomingFrom', () => {
  it('lists only the releases newer than the running version', () => {
    // 1.10.0 against 1.9.0: compared by number, not as text.
    const upcoming = upcomingFrom(CHANGELOG, '1.9.0')
    expect(upcoming.newer.map((entry) => entry.version)).toEqual(['1.10.0'])
    expect(upcoming.unreleased).toContain('Something new')
  })

  it('lists no release for the newest version', () => {
    expect(upcomingFrom(CHANGELOG, '1.10.0').newer).toEqual([])
  })
})

describe('fetchUpcoming', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads the development branch's changelog", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(CHANGELOG))
    vi.stubGlobal('fetch', fetchMock)

    const upcoming = await fetchUpcoming('1.8.0')

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/development/CHANGELOG.md')
    expect(upcoming.newer).toHaveLength(2)
  })

  it('throws on a failed request rather than answering "nothing planned"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    await expect(fetchUpcoming('1.8.0')).rejects.toThrow()
  })
})
