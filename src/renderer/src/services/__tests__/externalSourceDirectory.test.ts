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
  author: 'someone',
  icon: 'mdi-album',
  image: null,
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

  it('takes a webp from the repository of the app as its picture', () => {
    const raw = 'https://raw.githubusercontent.com/someone/folder/main/docs/icon.webp'
    expect(parseDirectoryApp({ ...APP, icon: raw })).toMatchObject({ image: raw, icon: 'mdi-web' })
    expect(
      parseDirectoryApp({ ...APP, icon: 'https://github.com/someone/folder/raw/main/icon.webp' })
        ?.image,
    ).toBe('https://github.com/someone/folder/raw/main/icon.webp')
  })

  it('turns a GitHub file page into the file itself', () => {
    expect(
      parseDirectoryApp({ ...APP, icon: 'https://github.com/someone/folder/blob/main/a/icon.webp' })
        ?.image,
    ).toBe('https://raw.githubusercontent.com/someone/folder/main/a/icon.webp')
  })

  it('finds the repository behind an address into one of its folders', () => {
    const app = {
      ...APP,
      repository: 'https://github.com/owner/beacon/tree/main/docs/examples/folder-source',
      icon: 'https://raw.githubusercontent.com/owner/beacon/main/docs/examples/folder-source/icon.webp',
    }
    expect(parseDirectoryApp(app)?.image).toBe(app.icon)
  })

  it('keeps to the repository on other hosts too', () => {
    const app = {
      ...APP,
      repository: 'https://codeberg.org/someone/folder',
      icon: 'https://codeberg.org/someone/folder/raw/branch/main/icon.webp',
    }
    expect(parseDirectoryApp(app)?.image).toBe(app.icon)
    expect(
      parseDirectoryApp({
        ...app,
        icon: 'https://raw.githubusercontent.com/someone/folder/x.webp',
      }),
    ).toBeNull()
  })

  it('refuses a picture from anywhere else, or not a webp', () => {
    for (const icon of [
      'https://raw.githubusercontent.com/someone-else/folder/main/icon.webp',
      'https://raw.githubusercontent.com/someone/other/main/icon.webp',
      'https://example.com/someone/folder/icon.webp',
      'https://raw.githubusercontent.com/someone/folder/main/icon.png',
      'https://raw.githubusercontent.com/someone/folder/main/icon.webp?x=1',
      'http://raw.githubusercontent.com/someone/folder/main/icon.webp',
      'data:image/webp;base64,AAAA',
    ]) {
      expect(parseDirectoryApp({ ...APP, icon }), icon).toBeNull()
    }
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

  it('needs an author that is a GitHub login', () => {
    expect(parseDirectoryApp({ ...APP, author: 'b-r-y' })?.author).toBe('b-r-y')
    for (const author of [undefined, '', '-x', 'x-', 'a--b', 'a/b', '@x', 'x'.repeat(40)]) {
      expect(parseDirectoryApp({ ...APP, author })).toBeNull()
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
  ) as { apps: unknown[]; _example: unknown }

  it('has only entries Beacon shows', () => {
    const shown = parseDirectory(file)
    expect(shown).toHaveLength(file.apps.length)
  })

  it('has an example to copy that would be shown as it is', () => {
    expect(parseDirectoryApp(file._example)).not.toBeNull()
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
