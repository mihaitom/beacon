import { readFile } from 'fs/promises'
import type { Plugin } from 'vite'

// The query presets.ts imports Beacon's shipped presets with.
const QUERY = '?compiled'
const PREFIX = '\0milkdrop-preset:'
const SUFFIX = '.preset.js'

interface Equations {
  baseVals?: { enabled?: number }
  init_eqs_str?: string
  frame_eqs_str?: string
  pixel_eqs_str?: string
  point_eqs_str?: string
}

function fn(body: string): string {
  // The newline: a body may end in a comment.
  return `function (a) {\n${body}\nreturn a;\n}`
}

/** The statements that hand `target` its equations as real functions, the
 * same ones Butterchurn's loadPreset() would build from the strings. */
function assignEquations(target: string, eqs: Equations, keys: (keyof Equations)[]): string[] {
  return keys
    .filter((key) => typeof eqs[key] === 'string')
    .map((key) => {
      const body = eqs[key] as string
      const name = key.replace(/_str$/, '')
      // Butterchurn's own convention: an empty per-pixel or per-point
      // block is '' rather than a function, and is skipped.
      const empty = (key === 'pixel_eqs_str' || key === 'point_eqs_str') && body === ''
      return `${target}.${name} = ${empty ? "''" : fn(body)};`
    })
}

/** Beacon's shipped Milkdrop presets with their equations compiled at build
 * time. Butterchurn otherwise builds them with `new Function` when a preset
 * loads, which the party guest page's Content-Security-Policy (script-src
 * 'self', no 'unsafe-eval') refuses - so do it here, where it is ordinary
 * module code. A preset whose `init_eqs` is already a function is taken
 * as it is. Uploaded presets still go through Butterchurn's own path; only
 * the app loads those. */
export function milkdropPresets(): Plugin {
  return {
    name: 'beacon:milkdrop-presets',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith(QUERY)) return null
      const resolved = await this.resolve(source.slice(0, -QUERY.length), importer, {
        skipSelf: true,
      })
      // Not ending in .json, or the bundler takes the module for JSON by
      // its extension and parses the code below as such.
      return resolved ? `${PREFIX}${resolved.id.replace(/\.json$/, '')}${SUFFIX}` : null
    },
    async load(id) {
      if (!id.startsWith(PREFIX) || !id.endsWith(SUFFIX)) return null
      const path = `${id.slice(PREFIX.length, -SUFFIX.length)}.json`
      this.addWatchFile(path)
      const file = JSON.parse(await readFile(path, 'utf8'))
      const preset = file.preset as Equations & { shapes?: Equations[]; waves?: Equations[] }
      // Butterchurn compiles nothing at all once `init_eqs` is a
      // function, so it and frame_eqs are always there.
      preset.init_eqs_str ??= ''
      preset.frame_eqs_str ??= ''
      const lines = [
        `const file = ${JSON.stringify(file)};`,
        'const preset = file.preset;',
        ...assignEquations('preset', preset, ['init_eqs_str', 'frame_eqs_str', 'pixel_eqs_str']),
      ]
      // Shapes and waves Butterchurn would leave without equations
      // (switched off) get none here either.
      ;(preset.shapes ?? []).forEach((shape, i) => {
        if (shape.baseVals?.enabled === 0) return
        lines.push(
          ...assignEquations(`preset.shapes[${i}]`, shape, ['init_eqs_str', 'frame_eqs_str']),
        )
      })
      ;(preset.waves ?? []).forEach((wave, i) => {
        if (wave.baseVals?.enabled === 0) return
        lines.push(
          ...assignEquations(`preset.waves[${i}]`, wave, [
            'init_eqs_str',
            'frame_eqs_str',
            'point_eqs_str',
          ]),
        )
      })
      lines.push('export default file;')
      return lines.join('\n')
    },
  }
}
