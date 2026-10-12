import { describe, expect, it } from 'vitest'
import { makeSong } from '@/stores/__tests__/fixtures'
import { pickPreviewSongs } from '../preview'

const songs = (...durations: number[]) =>
  durations.map((d, i) => makeSong(`s${i}`, { duration: d }))

describe('pickPreviewSongs', () => {
  it('spreads six over the list, both ends included', () => {
    expect(pickPreviewSongs(songs(...Array<number>(11).fill(200)))).toEqual([0, 2, 4, 6, 8, 10])
  })

  it('takes them all when there are no more than six', () => {
    expect(pickPreviewSongs(songs(200, 200, 200))).toEqual([0, 1, 2])
  })

  it('leaves out interludes, unless there is nothing else', () => {
    expect(pickPreviewSongs(songs(30, 200, 20, 200))).toEqual([1, 3])
    expect(pickPreviewSongs(songs(30, 20))).toEqual([0, 1])
    // A length the server does not know is no reason to leave a song out.
    expect(pickPreviewSongs(songs(0, 30))).toEqual([0])
  })
})
