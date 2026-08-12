import { fetchConnect } from './http'
import type { ConfigRequest, HealthResponse } from './types'

export async function postConfig(req: ConfigRequest): Promise<void> {
  await fetchConnect<{ status: string }>('/config', { method: 'POST', body: req })
}

export async function getHealth(): Promise<HealthResponse> {
  return fetchConnect<HealthResponse>('/health')
}
