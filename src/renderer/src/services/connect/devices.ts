import { fetchConnect } from './http'
import type { ConnectDeviceRef, DeviceType } from './types'

export async function join(target: ConnectDeviceRef, force = false): Promise<void> {
  await fetchConnect('/join', {
    method: 'POST',
    body: { target_name: target.name, target_type: target.type, force },
  })
}

export async function claim(targets: ConnectDeviceRef[], force = false): Promise<void> {
  await fetchConnect('/claim', {
    method: 'POST',
    body: { targets: targets.map((t) => ({ name: t.name, type: t.type })), force },
  })
}

export async function deviceStop(deviceType: DeviceType, name: string): Promise<void> {
  const params = new URLSearchParams({ device_type: deviceType, name })
  await fetchConnect(`/device-stop?${params.toString()}`, { method: 'POST' })
}
