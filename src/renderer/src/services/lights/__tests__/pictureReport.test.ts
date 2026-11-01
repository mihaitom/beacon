// Which picture Now Playing tells connect about, for the lights' colours:
// only with a bridge set up (the lights on or off), Fanart.tv's own URL,
// once per change.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useLightsStore } from '@/stores/lights'
import { fanartImageUrl } from '@/services/connect/fanart'
import { reportPicture } from '@/services/connect/lights'
import { reportForegroundPicture, resetPictureReport } from '../pictureReport'

vi.mock('@/services/connect/lights', () => ({ reportPicture: vi.fn(async () => {}) }))

const FANART = 'https://assets.fanart.tv/fanart/music/x/artistbackground/a.jpg'

function lights(paired: boolean, enabled = true) {
  useLightsStore().lights = {
    paired,
    enabled,
    area_id: 'area',
  } as ReturnType<typeof useLightsStore>['lights']
}

describe('reportForegroundPicture', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().apiUrl = 'http://connect.local'
    useAuthStore().connectToken = 'secret'
    resetPictureReport()
    vi.mocked(reportPicture).mockReset()
    lights(true)
  })

  it("hands connect Fanart.tv's own address, without this app's token", async () => {
    await reportForegroundPicture('s1', fanartImageUrl(FANART))
    expect(reportPicture).toHaveBeenCalledWith('s1', FANART)
  })

  it('says so when the cover is back in the foreground', async () => {
    await reportForegroundPicture('s1', fanartImageUrl(FANART))
    await reportForegroundPicture('s1', null)
    expect(reportPicture).toHaveBeenLastCalledWith('s1', null)
  })

  it('reports a change once', async () => {
    await reportForegroundPicture('s1', fanartImageUrl(FANART))
    await reportForegroundPicture('s1', fanartImageUrl(FANART))
    expect(reportPicture).toHaveBeenCalledTimes(1)
    await reportForegroundPicture('s2', fanartImageUrl(FANART))
    expect(reportPicture).toHaveBeenCalledTimes(2)
  })

  it('stays quiet without a bridge set up or without a song', async () => {
    lights(false)
    await reportForegroundPicture('s1', fanartImageUrl(FANART))
    lights(true)
    await reportForegroundPicture(null, fanartImageUrl(FANART))
    expect(reportPicture).not.toHaveBeenCalled()
  })

  it('reports with the lights switched off, for the dialog to show', async () => {
    lights(true, false)
    await reportForegroundPicture('s1', fanartImageUrl(FANART))
    expect(reportPicture).toHaveBeenCalledWith('s1', FANART)
  })

  it('reports the same picture again once paired anew', async () => {
    await reportForegroundPicture('s1', fanartImageUrl(FANART))
    lights(false)
    await reportForegroundPicture('s1', fanartImageUrl(FANART))
    lights(true)
    await reportForegroundPicture('s1', fanartImageUrl(FANART))
    expect(reportPicture).toHaveBeenCalledTimes(2)
  })

  it('tries again after a failed report', async () => {
    vi.mocked(reportPicture).mockRejectedValueOnce(new Error('connect away'))
    await reportForegroundPicture('s1', null)
    await reportForegroundPicture('s1', null)
    expect(reportPicture).toHaveBeenCalledTimes(2)
  })
})
