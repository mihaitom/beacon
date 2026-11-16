// The list of apps by others is fetched from the web: these pin what gets
// through and what is left out, and that the file in the repository is one
// Beacon reads whole - so a pull request with a broken entry fails here.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECTORY_BRANCH,
  DIRECTORY_URL,
  MAX_APPS,
  fetchDirectory,
  parseDirectory,
  parseDirectoryApp,
  repositoryLabel,
} from '../externalSourceDirectory'

const APP = {
  name: 'Folder',
  description: 'Plays a folder.',
  repository: 'https://github.com/someone/folder',
  icon: 'mdi-album',
}

describe('parseDirectoryApp', () => {
  it('reads a complete entry', () => {
    expect(parseDirectoryApp(APP)).toEqual(APP)
  })

  it('suggests the default icon when there is none', () => {
    const { icon: _, ...withoutIcon } = APP
    expect(parseDirectoryApp(withoutIcon)?.icon).toBe('mdi-web')
  })

  it('refuses an icon Beacon does not offer', () => {
    expect(parseDirectoryApp({ ...APP, icon: 'mdi-skull' })).toBeNull()
  })

  it('refuses an address that is not a plain https page', () => {
    for (const repository of [
      'http://github.com/a/b',
      'javascript:alert(1)',
      'https://user:pw@github.com/a/b',
      'github.com/a/b',
      42,
    ]) {
      expect(parseDirectoryApp({ ...APP, repository })).toBeNull()
    }
  })

  it('refuses missing, empty or overlong text', () => {
    expect(parseDirectoryApp({ ...APP, name: '' })).toBeNull()
    expect(parseDirectoryApp({ ...APP, name: 'x'.repeat(61) })).toBeNull()
    expect(parseDirectoryApp({ ...APP, description: undefined })).toBeNull()
    expect(parseDirectoryApp({ ...APP, description: 'x'.repeat(301) })).toBeNull()
  })

  it('evens out the spacing of its text', () => {
    expect(parseDirectoryApp({ ...APP, description: '  Plays\n  a folder. ' })?.description).toBe(
      'Plays a folder.',
    )
  })
})

describe('parseDirectory', () => {
  it('leaves out what does not fit and keeps the rest', () => {
    const apps = parseDirectory({ apps: [APP, { name: 'Broken' }, 'nonsense', null] })
    expect(apps).toEqual([APP])
  })

  it('keeps one entry per repository', () => {
    const again = { ...APP, name: 'Folder again', repository: 'https://github.com/someone/folder/' }
    expect(parseDirectory({ apps: [APP, again] })).toHaveLength(1)
  })

  it('sorts by name', () => {
    const b = { ...APP, name: 'beta', repository: 'https://github.com/x/b' }
    const a = { ...APP, name: 'Alpha', repository: 'https://github.com/x/a' }
    expect(parseDirectory({ apps: [b, a] }).map((app) => app.name)).toEqual(['Alpha', 'beta'])
  })

  it('reads nothing from a file of the wrong shape', () => {
    expect(parseDirectory(null)).toEqual([])
    expect(parseDirectory([APP])).toEqual([])
    expect(parseDirectory({ apps: 'x' })).toEqual([])
  })

  it('reads no more than its limit', () => {
    const many = Array.from({ length: MAX_APPS + 10 }, (_, n) => ({
      ...APP,
      repository: `https://github.com/x/${n}`,
    }))
    expect(parseDirectory({ apps: many })).toHaveLength(MAX_APPS)
  })
})

describe('community/external-sources.json', () => {
  const file = JSON.parse(
    readFileSync(resolve(process.cwd(), 'community/external-sources.json'), 'utf8'),
  ) as { apps: unknown[] }

  it('has only entries Beacon shows', () => {
    const shown = parseDirectory(file)
    expect(shown).toHaveLength(file.apps.length)
  })
})

describe('fetchDirectory', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the list from its branch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ apps: [APP] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchDirectory()).toEqual([APP])
    expect(fetchMock.mock.calls[0]![0]).toBe(DIRECTORY_URL)
    expect(DIRECTORY_URL).toContain(`/${DIRECTORY_BRANCH}/community/`)
  })

  it('fails on an error answer, so the dialog can say so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    await expect(fetchDirectory()).rejects.toThrow('404')
  })
})

describe('repositoryLabel', () => {
  it('drops the scheme and a trailing slash', () => {
    expect(repositoryLabel('https://www.github.com/a/b/')).toBe('github.com/a/b')
  })
})
