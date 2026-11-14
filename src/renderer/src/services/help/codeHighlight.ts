import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import nginx from 'highlight.js/lib/languages/nginx'
import python from 'highlight.js/lib/languages/python'
import yaml from 'highlight.js/lib/languages/yaml'

// Only the languages docs/help/ actually uses: the full set would add
// several hundred kilobytes for code nobody shows. A fence in another
// language (caddy, say) stays plain.
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('nginx', nginx)
hljs.registerLanguage('python', python)
hljs.registerLanguage('yaml', yaml)

/** markdown-it's `highlight` option: the fence as highlighted HTML, or ''
 * to let markdown-it escape it as plain text. highlight.js escapes the code
 * itself, so its output is safe to insert. */
export function highlightCode(code: string, language: string): string {
  if (!language || !hljs.getLanguage(language)) return ''
  return hljs.highlight(code, { language, ignoreIllegals: true }).value
}
