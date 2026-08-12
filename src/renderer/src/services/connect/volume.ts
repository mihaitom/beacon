import { fetchConnect } from './http'
import type { DeviceType } from './types'

export async function getGroupVolume(): Promise<number> {
  const data = await fetchConnect<{ volume: number }>('/volume')
  return data.volume
}

export async function setGroupVolume(volume: number): Promise<number> {
  const data = await fetchConnect<{ volume: number }>('/volume', {
    method: 'POST',
    body: { volume },
  })
  return data.volume
}

export async function getDeviceVolume(deviceType: DeviceType, name: string): Promise<number> {
  const params = new URLSearchParams({ device_type: deviceType, name })
  const data = await fetchConnect<{ volume: number }>(`/device-volume?${params.toString()}`)
  return data.volume
}

export async function setDeviceVolume(
  deviceType: DeviceType,
  name: string,
  volume: number,
): Promise<number> {
  const params = new URLSearchParams({ device_type: deviceType, name })
  const data = await fetchConnect<{ volume: number }>(`/device-volume?${params.toString()}`, {
    method: 'POST',
    body: { volume },
  })
  return data.volume
}
