import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectStore } from '../connect'
import { usePlaybackStore } from '../playback'
import { makeStatus } from './fixtures'

/** applyTargets() is the single place that turns "here is the set of devices
 * that should be playing" into calls, shared by the desktop picker, the
 * mobile picker and the phone's remote control. Before it existed each
 * surface did its own thing and the desktop's applied a selection with
 * castTo(), which replaces the target set instead of reconciling it. */
describe('playbackStore.applyTargets', () => {
  const kitchen = { name: 'Kitchen', type: 'sonos' as const }
  const living = { name: 'Living Room', type: 'sonos' as const }

  function withActive(targets: { name: string; type: 'sonos' }[]) {
    useConnectStore().status = makeStatus({ targets })
  }

  function spies() {
    const connect = useConnectStore()
    const playback = usePlaybackStore()
    return {
      join: vi.spyOn(connect, 'joinDevice').mockResolvedValue(),
      stop: vi.spyOn(connect, 'stopDevice').mockResolvedValue(),
      stopAll: vi.spyOn(connect, 'stopAll').mockResolvedValue(),
      castTo: vi.spyOn(playback, 'castTo').mockResolvedValue(),
      playback,
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('casts fresh when nothing is playing yet', async () => {
    const s = spies()

    await s.playback.applyTargets([kitchen])

    // castTo(), not join(): a first cast has to carry the queue, position
    // and paused-state handoff that joining a running session does not.
    expect(s.castTo).toHaveBeenCalledWith([kitchen], false)
    expect(s.join).not.toHaveBeenCalled()
  })

  it('passes force through to a fresh cast', async () => {
    const s = spies()

    await s.playback.applyTargets([kitchen], true)

    expect(s.castTo).toHaveBeenCalledWith([kitchen], true)
  })

  it('joins an added device instead of replacing the target set', async () => {
    withActive([kitchen])
    const s = spies()

    await s.playback.applyTargets([kitchen, living])

    // The regression this exists for: castTo([living]) would have dropped
    // Kitchen, which kept playing to the end of the track and then went
    // silent.
    expect(s.join).toHaveBeenCalledOnce()
    expect(s.join).toHaveBeenCalledWith(living)
    expect(s.castTo).not.toHaveBeenCalled()
    expect(s.stop).not.toHaveBeenCalled()
  })

  it('stops a device that was unchecked', async () => {
    withActive([kitchen, living])
    const s = spies()

    await s.playback.applyTargets([kitchen])

    expect(s.stop).toHaveBeenCalledOnce()
    expect(s.stop).toHaveBeenCalledWith('sonos', 'Living Room')
    expect(s.join).not.toHaveBeenCalled()
  })

  it('adds before removing when swapping devices, so the set is never empty', async () => {
    withActive([kitchen])
    const s = spies()
    const order: string[] = []
    s.join.mockImplementation(async () => void order.push('join'))
    s.stop.mockImplementation(async () => void order.push('stop'))

    await s.playback.applyTargets([living])

    // Order is the whole point. Removing first would leave no targets at
    // all in between, and an empty target set is not neutral — it hands
    // playback back to the local speakers, audibly.
    expect(order).toEqual(['join', 'stop'])
  })

  it('stops everything when the desired set is empty', async () => {
    withActive([kitchen, living])
    const s = spies()

    await s.playback.applyTargets([])

    expect(s.stopAll).toHaveBeenCalledOnce()
    expect(s.stop).not.toHaveBeenCalled()
  })

  it('does nothing at all when an empty set is applied with nothing casting', async () => {
    const s = spies()

    await s.playback.applyTargets([])

    expect(s.stopAll).not.toHaveBeenCalled()
    expect(s.castTo).not.toHaveBeenCalled()
  })

  it('is a no-op when the desired set already matches what is casting', async () => {
    withActive([kitchen, living])
    const s = spies()

    await s.playback.applyTargets([living, kitchen])

    expect(s.join).not.toHaveBeenCalled()
    expect(s.stop).not.toHaveBeenCalled()
    expect(s.castTo).not.toHaveBeenCalled()
    expect(s.stopAll).not.toHaveBeenCalled()
  })

  it('matches on type as well as name', async () => {
    withActive([kitchen])
    const s = spies()
    const airplayKitchen = { name: 'Kitchen', type: 'airplay' as const }

    await s.playback.applyTargets([kitchen, airplayKitchen])

    // Same name, different protocol: a genuinely different target, not the
    // one already casting.
    expect(s.join).toHaveBeenCalledOnce()
    expect(s.join).toHaveBeenCalledWith(airplayKitchen)
    expect(s.stop).not.toHaveBeenCalled()
  })
})
