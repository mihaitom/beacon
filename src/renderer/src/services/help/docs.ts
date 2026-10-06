import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
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

/** Shown one `## ` topic at a time rather than as one long page. */
const SPLIT_BY_TOPIC: ReadonlySet<HelpDocId> = new Set(['faq'])

/** One entry in the dialog's list: a whole doc, or one topic of a split
 * one. */
export interface HelpPage {
  id: string
  doc: HelpDocId
  file: string
  title: string
  body: string
  /** Every heading id on the page, so a link finds the page holding it. */
  anchors: Set<string>
}

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

function headingText(inline: Token | undefined): string {
  return (inline?.children ?? [])
    .filter((child) => child.type === 'text' || child.type === 'code_inline')
    .map((child) => child.content)
    .join('')
}

/** Heading ids in order, as GitHub numbers a repeated one: -1, -2, ... */
function headingIds() {
  const seen = new Map<string, number>()
  return (text: string): string => {
    const base = slugify(text)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count ? `${base}-${count}` : base
  }
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

function anchorsOf(body: string, own: string[] = []): Set<string> {
  const nextId = headingIds()
  const tokens = md.parse(body, {})
  const ids = tokens
    .map((token, idx) =>
      token.type === 'heading_open' ? nextId(headingText(tokens[idx + 1])) : null,
    )
    .filter((id): id is string => id !== null)
  return new Set([...own, ...ids])
}

function topicsOf(doc: HelpDoc): HelpPage[] {
  // Whatever stands before the first topic introduces the file on GitHub
  // and is left out here.
  const parts = doc.body.split(/^## +(.+)$/m).slice(1)
  const pages: HelpPage[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const title = parts[i]!.trim()
    const body = parts[i + 1] ?? ''
    pages.push({
      id: `${doc.id}/${slugify(title)}`,
      doc: doc.id,
      file: doc.file,
      title,
      body,
      anchors: anchorsOf(body, [slugify(title)]),
    })
  }
  return pages
}

export const HELP_PAGES: HelpPage[] = HELP_DOCS.flatMap((doc) =>
  SPLIT_BY_TOPIC.has(doc.id)
    ? topicsOf(doc)
    : [
        {
          id: doc.id,
          doc: doc.id,
          file: doc.file,
          title: doc.title,
          body: doc.body,
          anchors: anchorsOf(doc.body),
        },
      ],
)

/** The page of `doc` that holds `anchor`, or its first. */
export function pageFor(doc: HelpDocId, anchor: string | null = null): HelpPage {
  const pages = HELP_PAGES.filter((page) => page.doc === doc)
  return (anchor ? pages.find((page) => page.anchors.has(anchor)) : undefined) ?? pages[0]!
}

export function findHelpPage(id: string): HelpPage {
  return HELP_PAGES.find((page) => page.id === id) ?? HELP_PAGES[0]!
}

type RenderEnv = {
  page: HelpPage
  nextId: (text: string) => string
}

md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('id', (env as RenderEnv).nextId(headingText(tokens[idx + 1])))
  return self.renderToken(tokens, idx, options)
}

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!
  const { page } = env as RenderEnv
  const link = resolveLink(String(token.attrGet('href') ?? ''), page.file)
  if (link.kind === 'external') {
    token.attrSet('href', link.url)
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  } else {
    // Followed inside the dialog (see HelpDialog.vue's onContentClick), to
    // whichever page holds the heading - another topic of the same file
    // included.
    const target = pageFor(link.kind === 'doc' ? link.id : page.doc, link.anchor)
    token.attrSet('href', `#${link.anchor ?? ''}`)
    token.attrSet('data-help-page', target.id)
    token.attrSet('data-help-anchor', link.anchor ?? '')
  }
  return self.renderToken(tokens, idx, options)
}

export function renderHelpPage(page: HelpPage): string {
  const env: RenderEnv = { page, nextId: headingIds() }
  return md.render(page.body, env)
}
