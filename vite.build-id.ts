import { createHash } from 'crypto'
import type { Plugin } from 'vite'

/** Where the running web app looks for the deployed build's id. */
export const BUILD_ID_FILE = 'build.json'
/** The <meta> the running app reads its own build's id from. */
export const BUILD_ID_META = 'beacon-build'

/** An id for this build, derived from the names of every file it emitted.
 * Those carry Rollup's content hashes, so the id changes exactly when the
 * code does - a rebuild without changes keeps it, and no version bump is
 * needed for a rebuild with changes to be noticed. */
export function buildIdOf(fileNames: string[]): string {
  const relevant = fileNames.filter((name) => !name.endsWith('.html') && name !== BUILD_ID_FILE)
  return createHash('sha256').update(relevant.sort().join('\n')).digest('hex').slice(0, 16)
}

/** Writes the build id twice: into index.html, which is what an open tab
 * was loaded from, and into build.json, which is what is deployed now. A
 * difference between the two is a tab running an older build (see
 * services/buildCheck.ts). Kept out of the JavaScript on purpose - putting
 * it in a chunk would change the very hashes it is computed from. */
export function buildId(): Plugin {
  return {
    name: 'beacon:build-id',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const id = buildIdOf(Object.keys(bundle))
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.html')) continue
        const html =
          typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source)
        file.source = html.replace(
          '</head>',
          `<meta name="${BUILD_ID_META}" content="${id}">\n  </head>`,
        )
      }
      this.emitFile({ type: 'asset', fileName: BUILD_ID_FILE, source: JSON.stringify({ id }) })
    },
  }
}
