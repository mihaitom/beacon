import { fetchConnect } from './http'
import type { PairingStartResponse } from './types'

export async function listPaired(): Promise<string[]> {
  const data = await fetchConnect<{ paired: string[] }>('/pair/airplay')
  return data.paired
}

export async function startPairing(name: string, force = false): Promise<PairingStartResponse> {
  return fetchConnect<PairingStartResponse>('/pair/airplay/start', {
    method: 'POST',
    body: { name, force },
  })
}

export async function finishPairing(name: string, pin?: number): Promise<void> {
  await fetchConnect('/pair/airplay/finish', {
    method: 'POST',
    body: { name, pin: pin ?? null },
  })
}

export async function unpair(name: string): Promise<void> {
  await fetchConnect(`/pair/airplay/${encodeURIComponent(name)}`, { method: 'DELETE' })
}
