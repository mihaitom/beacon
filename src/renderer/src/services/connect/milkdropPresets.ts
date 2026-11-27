import type { MilkdropPreset } from 'butterchurn'
import { fetchConnect } from './http'

/** An uploaded Milkdrop preset as the list shows it - see
 * connect/routes/milkdrop_presets.py. */
export interface CustomMilkdropPreset {
  id: string
  name: string
}

export async function listMilkdropPresets(): Promise<CustomMilkdropPreset[]> {
  const answer = await fetchConnect<{ presets: CustomMilkdropPreset[] }>('/milkdrop-presets')
  return answer.presets
}

export async function getMilkdropPreset(
  id: string,
): Promise<CustomMilkdropPreset & { preset: MilkdropPreset }> {
  return fetchConnect(`/milkdrop-presets/${encodeURIComponent(id)}`)
}

export async function putMilkdropPreset(
  id: string,
  name: string,
  preset: MilkdropPreset,
): Promise<void> {
  await fetchConnect(`/milkdrop-presets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { name, preset },
  })
}

export async function deleteMilkdropPreset(id: string): Promise<void> {
  await fetchConnect(`/milkdrop-presets/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
