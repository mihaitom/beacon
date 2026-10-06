import MarkdownIt from 'markdown-it'
import faqRaw from '../../../../../docs/faq.md?raw'
import partyModeRaw from '../../../../../docs/party-mode.md?raw'
import transcodingRaw from '../../../../../docs/transcoding-decisions.md?raw'
import homeAutomationRaw from '../../../../../docs/home-automation.md?raw'
import packageJson from '../../../../../package.json'

/** The docs/ files the help dialog shows, bundled at build time like
 * CHANGELOG.md in releaseNotes.vue. English only - they are the repo's own
 * docs, not translated copies. A new one also goes into the Dockerfile's
 * COPY, which only copies these. */
export type HelpDocId = 'faq' | 'party-mode' | 'transcoding' | 'home-automation'

export interface HelpDoc {
  id: HelpDocId
  /** Its name under docs/, which is what other docs link to it by. */
  file: string
  /** The file's own `# ` heading. */
  title: string
  /** Everything under that heading. */
  body: string
}

export type HelpLink =
  | { kind: 'doc'; id: HelpDocId; anchor: string | null }
  | { kind: 'anchor'; anchor: string }
  | { kind: 'external'; url: string }

/** Where links to anything not bundled here point: the repository as of the
 * last release. */
const REPO_URL = `${packageJson.homepage}/blob/main`
const REPO_TREE_URL = `${packageJson.homepage}/tree/main`

function splitTitle(raw: string): { title: string; body: string } {
  const match = raw.match(/^#\s+(.+)\r?\n/)
  return match
    ? { title: match[1]!.trim(), body: raw.slice(match[0].length) }
    : { title: '', body: raw }
}

function helpDoc(id: HelpDocId, file: string, raw: string): HelpDoc {
  return { id, file, ...splitTitle(raw) }
}

export const HELP_DOCS: HelpDoc[] = [
  helpDoc('faq', 'faq.md', faqRaw),
  helpDoc('party-mode', 'party-mode.md', partyModeRaw),
  helpDoc('transcoding', 'transcoding-decisions.md', transcodingRaw),
  helpDoc('home-automation', 'home-automation.md', homeAutomationRaw),
]

/** A heading's anchor as GitHub makes it, so the links the docs already
 * carry for GitHub (`faq.md#no-devices-found`) work here unchanged:
 * lower case, punctuation dropped, every space a hyphen - which is why
 * "Traefik + Authentik" becomes `traefik--authentik`. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

/** What a link in `fromFile` (a docs/ file name) points at. Relative paths
 * resolve the way GitHub resolves them, so `../home-assistant/` leaves
 * docs/. */
export function resolveLink(href: string, fromFile: string): HelpLink {
  if (href.startsWith('#')) return { kind: 'anchor', anchor: decodeURIComponent(href.slice(1)) }
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return { kind: 'external', url: href }

  const resolved = new URL(href, `https://repo.invalid/docs/${fromFile}`)
  const anchor = resolved.hash ? decodeURIComponent(resolved.hash.slice(1)) : null
  const target = HELP_DOCS.find((doc) => resolved.pathname === `/docs/${doc.file}`)
  if (target) return { kind: 'doc', id: target.id, anchor }
  const base = resolved.pathname.endsWith('/') ? REPO_TREE_URL : REPO_URL
  return { kind: 'external', url: `${base}${resolved.pathname}${resolved.hash}` }
}

const md = new MarkdownIt({ html: false, linkify: true })

type RenderEnv = {
  file: string
  slugs: Map<string, number>
}

md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const { slugs } = env as RenderEnv
  const text = (tokens[idx + 1]?.children ?? [])
    .filter((child) => child.type === 'text' || child.type === 'code_inline')
    .map((child) => child.content)
    .join('')
  // GitHub numbers a repeated heading -1, -2, ...
  const base = slugify(text)
  const seen = slugs.get(base) ?? 0
  slugs.set(base, seen + 1)
  tokens[idx]!.attrSet('id', seen ? `${base}-${seen}` : base)
  return self.renderToken(tokens, idx, options)
}

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!
  const link = resolveLink(String(token.attrGet('href') ?? ''), (env as RenderEnv).file)
  if (link.kind === 'external') {
    token.attrSet('href', link.url)
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  } else {
    // Followed inside the dialog (see HelpDialog.vue's onContentClick); no
    // doc means this one.
    token.attrSet('href', `#${link.anchor ?? ''}`)
    token.attrSet('data-help-doc', link.kind === 'doc' ? link.id : '')
    token.attrSet('data-help-anchor', link.anchor ?? '')
  }
  return self.renderToken(tokens, idx, options)
}

export function renderHelpDoc(doc: HelpDoc): string {
  const env: RenderEnv = { file: doc.file, slugs: new Map() }
  return md.render(doc.body, env)
}

export function findHelpDoc(id: HelpDocId): HelpDoc {
  return HELP_DOCS.find((doc) => doc.id === id) ?? HELP_DOCS[0]!
}
