// The list of apps by others is fetched from the web: these pin what gets
// through and what is left out, and that the file in the repository is one
// Beacon reads whole - so a pull request with a broken entry fails here.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STARS_TTL_MS,
  fetchAllStars,
  fetchStars,
  readStars,
  repositoryPath,
  sortByStars,
  starsApiUrl,
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

  it('takes repositories on GitHub, Codeberg and GitLab only', () => {
    for (const repository of [
      'https://codeberg.org/someone/folder',
      'https://gitlab.com/someone/folder',
    ]) {
      expect(parseDirectoryApp({ ...APP, repository })?.repository, repository).toBe(repository)
    }
    for (const repository of [
      'https://git.example.com/someone/folder',
      'https://www.github.com/someone/folder',
      'https://github.com.example.com/someone/folder',
      'https://raw.githubusercontent.com/someone/folder',
      'https://github.com:8443/someone/folder',
      'https://github.com/someone',
    ]) {
      expect(parseDirectoryApp({ ...APP, repository }), repository).toBeNull()
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
    expect(repositoryLabel('https://github.com/a/b/')).toBe('github.com/a/b')
  })
})

describe('repositoryPath', () => {
  it('is owner and name, also from an address into a folder', () => {
    expect(repositoryPath('https://github.com/a/b/tree/main/docs/x')).toBe('a/b')
    expect(repositoryPath('https://codeberg.org/a/b')).toBe('a/b')
  })

  it('keeps nested GitLab groups, up to GitLab own pages', () => {
    expect(repositoryPath('https://gitlab.com/group/sub/app/-/tree/main/docs')).toBe(
      'group/sub/app',
    )
  })
})

describe('starsApiUrl', () => {
  it('asks each host its own API', () => {
    expect(starsApiUrl('https://github.com/a/b/tree/main/x')).toBe(
      'https://api.github.com/repos/a/b',
    )
    expect(starsApiUrl('https://codeberg.org/a/b')).toBe('https://codeberg.org/api/v1/repos/a/b')
    expect(starsApiUrl('https://gitlab.com/g/sub/app')).toBe(
      'https://gitlab.com/api/v4/projects/g%2Fsub%2Fapp',
    )
  })
})

describe('readStars', () => {
  it('reads whichever name the host uses', () => {
    expect(readStars({ stargazers_count: 5 })).toBe(5)
    expect(readStars({ stars_count: 6 })).toBe(6)
    expect(readStars({ star_count: 7 })).toBe(7)
  })

  it('reads nothing that is not a count', () => {
    expect(readStars({ stargazers_count: '5' })).toBeNull()
    expect(readStars({ stargazers_count: -1 })).toBeNull()
    expect(readStars({ stargazers_count: 1.5 })).toBeNull()
    expect(readStars(null)).toBeNull()
  })
})

describe('fetchStars', () => {
  const REPO = 'https://github.com/a/b'

  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  function answer(body: unknown, status = 200) {
    return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
  }

  it('asks once and keeps the answer for a while', async () => {
    const fetchMock = answer({ stargazers_count: 12 })
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchStars(REPO, undefined, 1000)).toBe(12)
    expect(await fetchStars(REPO, undefined, 1000 + STARS_TTL_MS - 1)).toBe(12)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await fetchStars(REPO, undefined, 1000 + STARS_TTL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps an old count when the host says no, and has none without one', async () => {
    vi.stubGlobal('fetch', answer({ message: 'rate limit' }, 403))
    expect(await fetchStars(REPO, undefined, 0)).toBeNull()
    vi.stubGlobal('fetch', answer({ stargazers_count: 3 }))
    await fetchStars(REPO, undefined, 0)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await fetchStars(REPO, undefined, STARS_TTL_MS * 2)).toBe(3)
  })
})

describe('fetchAllStars and sortByStars', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  const app = (name: string, repo: string) => ({ ...APP, name, repository: repo })

  it('sorts by stars, then by name, those without any last', async () => {
    const apps = [
      app('Beta', 'https://github.com/x/beta'),
      app('Alpha', 'https://github.com/x/alpha'),
      app('Many', 'https://github.com/x/many'),
      app('Unknown', 'https://github.com/x/unknown'),
    ]
    const counts: Record<string, number> = { beta: 5, alpha: 5, many: 90 }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const count = counts[url.split('/').pop()!]
        return count === undefined
          ? new Response('', { status: 404 })
          : new Response(JSON.stringify({ stargazers_count: count }))
      }),
    )
    const stars = await fetchAllStars(apps)
    expect(stars.has('https://github.com/x/unknown')).toBe(false)
    expect(sortByStars(apps, stars).map((a) => a.name)).toEqual([
      'Many',
      'Alpha',
      'Beta',
      'Unknown',
    ])
  })
})
