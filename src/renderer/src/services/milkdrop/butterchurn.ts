import butterchurnModule, { type Butterchurn } from 'butterchurn'

/** Butterchurn itself, whichever way the bundler handed it over. It is an
 * old webpack bundle flagged `__esModule`: the production build unwraps its
 * default export, the dev server's pre-bundling does not and
 * hands over `{ default: Butterchurn }`. */
export function resolveButterchurn(module: Butterchurn | { default: Butterchurn }): Butterchurn {
  return 'createVisualizer' in module ? module : module.default
}

export const butterchurn = resolveButterchurn(butterchurnModule)
