import { fetchConnect } from './http'
import type { DiscoverResponse } from './types'

export async function getDiscover(fresh = false): Promise<DiscoverResponse> {
  return fetchConnect<DiscoverResponse>(`/discover?fresh=${fresh}`)
}
