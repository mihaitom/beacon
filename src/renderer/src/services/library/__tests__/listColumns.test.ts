import { describe, expect, it } from 'vitest'
import { DEFAULT_ALBUM_COLUMNS, albumColumnsFor } from '../albumColumns'
import { artistColumnsFor } from '../artistColumns'

const keys = (columns: { key: string }[]) => columns.map((column) => column.key)

describe('the album list columns', () => {
  it('draws the chosen ones between the cover, the name and the actions', () => {
    expect(keys(albumColumnsFor(['year', 'genre'], 0, true))).toEqual([
      'cover',
      'name',
      'genre',
      'year',
      'actions',
    ])
  })

  it('leaves the rating out on a server without one', () => {
    expect(keys(albumColumnsFor(['rating', 'year'], 0, false))).not.toContain('rating')
  })

  it('gives way in a narrow list, the least asked-for first', () => {
    const wide = keys(albumColumnsFor([...DEFAULT_ALBUM_COLUMNS, 'releaseType'], 2000, true))
    // One column short of room for all of them.
    const narrow = keys(albumColumnsFor([...DEFAULT_ALBUM_COLUMNS, 'releaseType'], 1050, true))

    expect(wide).toContain('releaseType')
    expect(narrow).not.toContain('releaseType')
    expect(narrow).toEqual(wide.filter((key) => key !== 'releaseType'))
  })

  it('keeps the cover, the name and the actions however narrow', () => {
    expect(keys(albumColumnsFor(DEFAULT_ALBUM_COLUMNS, 300, true))).toEqual([
      'cover',
      'name',
      'actions',
    ])
  })

  it('keeps every chosen column before the list is measured', () => {
    expect(keys(albumColumnsFor(['genre', 'added'], 0, true))).toEqual([
      'cover',
      'name',
      'genre',
      'added',
      'actions',
    ])
  })
})

describe('the artist list columns', () => {
  it('gives up the rating before the counts', () => {
    const columns = keys(artistColumnsFor(['albumCount', 'songCount', 'rating'], 600, true))

    expect(columns).not.toContain('rating')
    expect(columns).toContain('albumCount')
  })
})
