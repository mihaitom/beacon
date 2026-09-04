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
      join: vi.spyOn(connect, 'joinDevice').mockResolvedValue(true),
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
    expect(s.join).toHaveBeenCalledWith(living, false)
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
    s.join.mockImplementation(async () => {
      order.push('join')
      return true
    })
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

  it('passes force through to each join, not just to a fresh cast', async () => {
    withActive([kitchen])
    const s = spies()

    await s.playback.applyTargets([kitchen, living], true)

    // The phone remote always forces (it has no confirm dialog of its
    // own — see services/remoteControl/commands.ts). force used to reach
    // only the fresh-cast branch, so a switch made from the phone while
    // something was already casting silently parked a takeover dialog on
    // the desktop instead.
    expect(s.join).toHaveBeenCalledWith(living, true)
  })

  it('does not stop the old device when the new one hit a takeover conflict', async () => {
    withActive([kitchen])
    const connect = useConnectStore()
    const s = spies()
    // What withTakeoverHandling() does with a device_in_use: no throw, a
    // pending takeover, and false for "this did not actually happen".
    s.join.mockImplementation(async () => {
      connect.pendingTakeover = {
        device: living,
        owner: 'someone else',
        retry: async () => {},
      }
      return false
    })

    await s.playback.applyTargets([living])

    // Kitchen must keep playing. Stopping it here left no targets at all
    // without the `displaced` flag that tells the frontend to go quiet, so
    // playback jumped to the local speakers — and confirming the takeover
    // afterwards then found no stream left to join (routes/join.py refuses
    // a session that is not streaming).
    expect(s.stop).not.toHaveBeenCalled()
  })

  it('retries the whole apply, forced, once the takeover is confirmed', async () => {
    withActive([kitchen])
    const connect = useConnectStore()
    const s = spies()
    s.join.mockImplementationOnce(async () => {
      connect.pendingTakeover = { device: living, owner: 'x', retry: async () => {} }
      return false
    })

    await s.playback.applyTargets([living])

    const applySpy = vi.spyOn(s.playback, 'applyTargets')
    await connect.pendingTakeover!.retry()

    // Not just a replay of the one join that conflicted: that would leave
    // the rest of the desired set — the removals in particular — unapplied
    // forever.
    expect(applySpy).toHaveBeenCalledWith([living], true)
  })

  it('matches on type as well as name', async () => {
    withActive([kitchen])
    const s = spies()
    const airplayKitchen = { name: 'Kitchen', type: 'airplay' as const }

    await s.playback.applyTargets([kitchen, airplayKitchen])

    // Same name, different protocol: a genuinely different target, not the
    // one already casting.
    expect(s.join).toHaveBeenCalledOnce()
    expect(s.join).toHaveBeenCalledWith(airplayKitchen, false)
    expect(s.stop).not.toHaveBeenCalled()
  })
})
