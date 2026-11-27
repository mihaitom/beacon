import type { MilkdropPreset } from 'butterchurn'
import converterUrl from '@/vendor/milkdrop-preset-converter/milkdrop-preset-converter.min.js?url'

interface Converter {
  convertPreset(text: string): Promise<MilkdropPreset>
}

declare global {
  interface Window {
    milkdropPresetConverter?: Converter
  }
}

let loading: Promise<Converter> | null = null

/** Butterchurn's own converter, loaded on the first upload only (it is
 * most of a megabyte). As a classic script rather than an import: it is an
 * old UMD bundle, and run as a module it would be held to strict mode it
 * was never written for. It puts itself on `window`. */
function loadConverter(): Promise<Converter> {
  loading ??= new Promise<Converter>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = converterUrl
    script.onload = () => {
      const converter = window.milkdropPresetConverter
      if (converter) resolve(converter)
      else reject(new Error('Milkdrop converter did not load'))
    }
    script.onerror = () => reject(new Error('Milkdrop converter did not load'))
    document.head.appendChild(script)
  }).catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

/** A preset file as a listener has it, ready for Butterchurn: a Milkdrop
 * `.milk` file is converted, a `.json` one is taken as already converted
 * (Butterchurn's own format, or a Beacon preset file with a name). Throws
 * for anything that is neither. */
export async function presetFromFile(
  fileName: string,
  text: string,
  converter: () => Promise<Converter> = loadConverter,
): Promise<{ name: string; preset: MilkdropPreset }> {
  const name = fileName.replace(/\.(milk|json)$/i, '').trim() || fileName
  if (/\.json$/i.test(fileName)) {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const preset = (parsed.preset ?? parsed) as MilkdropPreset
    if (typeof preset !== 'object' || preset === null || !('baseVals' in preset)) {
      throw new Error('Not a Butterchurn preset')
    }
    return { name: typeof parsed.name === 'string' ? parsed.name : name, preset }
  }
  const preset = await (await converter()).convertPreset(text)
  if (!preset || typeof preset !== 'object' || !('baseVals' in preset)) {
    throw new Error('Not a Milkdrop preset')
  }
  return { name, preset }
}
