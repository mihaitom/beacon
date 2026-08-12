import { fetchConnect } from './http'
import type { ConnectDeviceRef, PlayResponse } from './types'

interface PlayOptions {
  targets?: ConnectDeviceRef[]
  gain?: number
  startPosition?: number
  force?: boolean
}

export async function play(trackId: string, options: PlayOptions = {}): Promise<PlayResponse> {
  return fetchConnect<PlayResponse>('/play', {
    method: 'POST',
    body: {
      track_ids: [trackId],
      targets: options.targets?.map((t) => ({ name: t.name, type: t.type })),
      gain: options.gain ?? 1.0,
      start_position: options.startPosition ?? 0,
      force: options.force ?? false,
    },
  })
}

export async function playUrl(
  url: string,
  title: string,
  options: { targets?: ConnectDeviceRef[]; force?: boolean } = {},
): Promise<void> {
  await fetchConnect('/play-url', {
    method: 'POST',
    body: {
      url,
      title,
      targets: options.targets?.map((t) => ({ name: t.name, type: t.type })),
      force: options.force ?? false,
    },
  })
}

export async function pause(): Promise<void> {
  await fetchConnect('/pause', { method: 'POST' })
}

export async function resume(): Promise<void> {
  await fetchConnect('/resume', { method: 'POST' })
}

export async function seek(position: number): Promise<void> {
  await fetchConnect('/seek', { method: 'POST', body: { position } })
}

export async function stop(): Promise<void> {
  await fetchConnect('/stop', { method: 'POST' })
}
