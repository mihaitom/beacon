import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectStore } from '../connect'
import { claim, join } from '@/services/connect/devices'
import { getDiscover } from '@/services/connect/discovery'
import { ConnectApiError } from '@/services/connect/http'

vi.mock('@/services/connect/devices', () => ({
  join: vi.fn(),
  claim: vi.fn(),
  deviceStop: vi.fn(),
}))
vi.mock('@/services/connect/discovery', () => ({ getDiscover: vi.fn() }))

const kitchen = { name: 'Kitchen', type: 'sonos' as const }

/** What connect answers with when the device is already playing for
 * somebody else (see routes/devices.py) — the one error the picker turns
 * into a "take it over?" prompt rather than a plain failure. */
function deviceInUse(): ConnectApiError {
  return new ConnectApiError('Device in use', {
    error: 'device_in_use',
    device: 'Kitchen',
    owner: 'thomas@laptop',
  })
}

describe('taking over a device someone else is using', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(getDiscover).mockResolvedValue({ devices: [], scanning: false } as unknown as Awaited<
      ReturnType<typeof getDiscover>
    >)
  })

  it('asks first instead of claiming a device out from under someone', async () => {
    const connect = useConnectStore()
    vi.mocked(join).mockRejectedValue(deviceInUse())

    await connect.joinDevice(kitchen)

    // No throw: the picker gets a prompt to show, not an error.
    expect(connect.pendingTakeover).toMatchObject({ device: 'Kitchen', owner: 'thomas@laptop' })
    expect(join).toHaveBeenCalledWith(kitchen, false)
  })

  it('reports whether the action actually went through', async () => {
    const connect = useConnectStore()
    vi.mocked(join).mockResolvedValueOnce(undefined)
    expect(await connect.joinDevice(kitchen)).toBe(true)

    vi.mocked(join).mockRejectedValueOnce(deviceInUse())
    // False, not a throw: the target was never reached, and a caller
    // mid-way through a larger change (playbackStore.applyTargets()) has
    // to stop rather than carry on against a set it never applied.
    expect(await connect.joinDevice(kitchen)).toBe(false)
  })

  it('skips the confirmation entirely for an already-forced join', async () => {
    const connect = useConnectStore()
    vi.mocked(join).mockResolvedValue(undefined)

    expect(await connect.joinDevice(kitchen, true)).toBe(true)

    // The decision to take the device over is already made — the phone
    // remote makes it up front, since it has no dialog to ask with (see
    // services/remoteControl/commands.ts).
    expect(join).toHaveBeenCalledWith(kitchen, true)
    expect(connect.pendingTakeover).toBeNull()
  })

  it('throws a forced join that fails instead of parking a dialog', async () => {
    const connect = useConnectStore()
    vi.mocked(join).mockRejectedValue(deviceInUse())

    await expect(connect.joinDevice(kitchen, true)).rejects.toThrow()

    // Nothing left to confirm: force already said yes, so a conflict here
    // is a real failure and has to be reported as one.
    expect(connect.pendingTakeover).toBeNull()
    expect(connect.errors.message).not.toBeNull()
  })

  it('swaps in a wider retry when the conflict came out of a larger change', async () => {
    const connect = useConnectStore()
    vi.mocked(join).mockRejectedValue(deviceInUse())
    await connect.joinDevice(kitchen)

    const wider = vi.fn().mockResolvedValue(undefined)
    connect.setTakeoverRetry(wider)
    await connect.confirmTakeover()

    // Replaying only the join that conflicted would leave the rest of
    // applyTargets()'s desired set — the removals above all — unapplied.
    expect(wider).toHaveBeenCalled()
  })

  it('leaves setTakeoverRetry alone when nothing is pending', () => {
    const connect = useConnectStore()
    connect.setTakeoverRetry(vi.fn())
    expect(connect.pendingTakeover).toBeNull()
  })

  it('records a failed device stop instead of failing silently', async () => {
    const { deviceStop } = await import('@/services/connect/devices')
    const connect = useConnectStore()
    vi.mocked(deviceStop).mockRejectedValue(new Error('speaker went away'))

    await expect(connect.stopDevice('sonos', 'Kitchen')).rejects.toThrow()

    // The backend releases the claim whether or not the stop worked (see
    // routes/devices.py), so silence here leaves a speaker playing with
    // nothing saying so.
    expect(connect.errors.message).not.toBeNull()
  })

  it('retries with force once the user confirms, and refreshes what the list shows', async () => {
    // Without the refresh the device list keeps showing the previous owner
    // until something else happens to reload it.
    const connect = useConnectStore()
    vi.mocked(join).mockRejectedValueOnce(deviceInUse()).mockResolvedValue(undefined)
    await connect.joinDevice(kitchen)

    await connect.confirmTakeover()

    expect(join).toHaveBeenLastCalledWith(kitchen, true)
    expect(connect.pendingTakeover).toBeNull()
    expect(getDiscover).toHaveBeenCalled()
  })

  it('reports a forced retry that fails rather than closing the dialog silently', async () => {
    // The confirm dialog calls this from a bare @click with no catch of its
    // own, so a device that went offline in the meantime has to surface here.
    const connect = useConnectStore()
    vi.mocked(join)
      .mockRejectedValueOnce(deviceInUse())
      .mockRejectedValue(new Error('Device unreachable'))
    await connect.joinDevice(kitchen)

    await expect(connect.confirmTakeover()).resolves.toBeUndefined()

    expect(connect.errors.message).toBe('Device unreachable')
    expect(connect.pendingTakeover).toBeNull()
  })

  it('does nothing when there is no pending takeover to confirm', async () => {
    const connect = useConnectStore()

    await connect.confirmTakeover()

    expect(join).not.toHaveBeenCalled()
    expect(getDiscover).not.toHaveBeenCalled()
  })

  it('drops the request when the user backs out', async () => {
    const connect = useConnectStore()
    vi.mocked(join).mockRejectedValue(deviceInUse())
    await connect.joinDevice(kitchen)

    connect.cancelTakeover()

    expect(connect.pendingTakeover).toBeNull()
    expect(join).toHaveBeenCalledOnce() // never forced
  })

  it('surfaces any other failure as a plain error, with nothing to confirm', async () => {
    const connect = useConnectStore()
    vi.mocked(claim).mockRejectedValue(new Error('Connect backend unreachable'))

    await expect(connect.claimDevices([kitchen])).rejects.toThrow('Connect backend unreachable')

    expect(connect.pendingTakeover).toBeNull()
    expect(connect.errors.message).toBe('Connect backend unreachable')
  })

  it('clears a previous error once a claim goes through', async () => {
    const connect = useConnectStore()
    connect.errors.message = 'something older'
    vi.mocked(claim).mockResolvedValue(undefined)

    await connect.claimDevices([kitchen])

    expect(connect.errors.message).toBeNull()
  })
})
