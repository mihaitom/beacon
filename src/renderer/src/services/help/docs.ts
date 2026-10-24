import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import packageJson from '../../../../../package.json'

/** Everything under docs/help/, bundled at build time like CHANGELOG.md in
 * releaseNotes.vue: one file, one page. English only - they are the repo's
 * own docs, not translated copies. */
const HELP_FILES = import.meta.glob<string>('../../../../../docs/help/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** One page of the help dialog, scrolled to a heading. */
export interface HelpTarget {
  page: string
  anchor: string | null
}

export type HelpLink =
  | { kind: 'doc'; id: string; anchor: string | null }
  | { kind: 'anchor'; anchor: string }
  | { kind: 'external'; url: string }

/** Where links to anything not bundled here point: the repository as of the
 * last release. */
const REPO_URL = `${packageJson.homepage}/blob/main`
const REPO_TREE_URL = `${packageJson.homepage}/tree/main`

export interface HelpPage {
  /** The file's path under docs/help/ without `.md`: `party-mode`,
   * `faq/playback`. */
  id: string
  /** Where it lives in the repository, which is what links resolve against. */
  path: string
  /** The file's own `# ` heading. */
  title: string
  /** Everything under that heading. */
  body: string
  /** From the file's front matter; pages without one come last. */
  order: number
  /** Every heading id on the page, so a link finds the page holding it. */
  anchors: Set<string>
}

/** A heading's anchor as GitHub makes it, so the links the docs already
 * carry for GitHub (`faq/troubleshooting.md#no-devices-found`) work here
 * unchanged: lower case, punctuation dropped, every space a hyphen - which
 * is why "Traefik + Authentik" becomes `traefik--authentik`. */
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

const md = new MarkdownIt({ html: false, linkify: true })

function anchorsOf(body: string): Set<string> {
  const nextId = headingIds()
  const tokens = md.parse(body, {})
  const ids = tokens
    .map((token, idx) =>
      token.type === 'heading_open' ? nextId(headingText(tokens[idx + 1])) : null,
    )
    .filter((id): id is string => id !== null)
  return new Set(ids)
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n+/
const TITLE = /^#\s+(.+)\r?\n/

function helpPage(file: string, raw: string): HelpPage {
  const path = file.slice(file.indexOf('docs/help/'))
  const front = raw.match(FRONT_MATTER)
  const order = front?.[1]!.match(/^order:\s*(\d+)\s*$/m)?.[1]
  const content = front ? raw.slice(front[0].length) : raw
  const title = content.match(TITLE)
  const body = title ? content.slice(title[0].length) : content
  return {
    id: path.slice('docs/help/'.length, -'.md'.length),
    path,
    title: title ? title[1]!.trim() : '',
    body,
    order: order ? Number(order) : Infinity,
    anchors: anchorsOf(body),
  }
}

export const HELP_PAGES: HelpPage[] = Object.entries(HELP_FILES)
  .map(([file, raw]) => helpPage(file, raw))
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

export function findHelpPage(id: string): HelpPage {
  return HELP_PAGES.find((page) => page.id === id) ?? HELP_PAGES[0]!
}

/** The page `id` names, or in the folder it names (`faq`) the one that
 * holds `anchor`, or its first. */
export function pageFor(id: string, anchor: string | null = null): HelpPage {
  const pages = HELP_PAGES.filter((page) => page.id === id || page.id.startsWith(`${id}/`))
  return (anchor ? pages.find((page) => page.anchors.has(anchor)) : undefined) ?? pages[0]!
}

/** The FAQ, one page per topic. */
export function isFaqPage(page: HelpPage): boolean {
  return page.id.startsWith('faq/')
}

/** What someone already running Beacon gets out of the README, heading the
 * help dialog's FAQ as "What Beacon can do". */
export const FEATURES_PAGE = findHelpPage('features')

/** What a link in the file at `fromPath` (relative to the repository root)
 * points at. Relative paths resolve the way GitHub resolves them, so
 * `../../home-assistant/` from a page leaves docs/. */
export function resolveLink(href: string, fromPath: string): HelpLink {
  if (href.startsWith('#')) return { kind: 'anchor', anchor: decodeURIComponent(href.slice(1)) }
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return { kind: 'external', url: href }

  const resolved = new URL(href, `https://repo.invalid/${fromPath}`)
  const anchor = resolved.hash ? decodeURIComponent(resolved.hash.slice(1)) : null
  const target = HELP_PAGES.find((page) => resolved.pathname === `/${page.path}`)
  if (target) return { kind: 'doc', id: target.id, anchor }
  const base = resolved.pathname.endsWith('/') ? REPO_TREE_URL : REPO_URL
  return { kind: 'external', url: `${base}${resolved.pathname}${resolved.hash}` }
}

/** The page a link opens in the app, or null for one that leaves it. */
function targetPage(link: HelpLink, page: HelpPage): HelpPage | null {
  if (link.kind === 'external') return null
  if (link.kind === 'doc') return findHelpPage(link.id)
  return page.anchors.has(link.anchor) ? page : null
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
  const link = resolveLink(String(token.attrGet('href') ?? ''), page.path)
  const target = targetPage(link, page)
  if (target) {
    // Followed inside the app (see HelpDialog.vue's onContentClick).
    const anchor = link.kind === 'external' ? null : link.anchor
    token.attrSet('href', `#${anchor ?? ''}`)
    token.attrSet('data-help-page', target.id)
    token.attrSet('data-help-anchor', anchor ?? '')
  } else {
    const url =
      link.kind === 'external' ? link.url : `${REPO_URL}/${page.path}#${link.anchor ?? ''}`
    token.attrSet('href', url)
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  return self.renderToken(tokens, idx, options)
}

/** Between these two lines, each heading starts a tab, one per heading of
 * the level the first one has: alternatives of which a reader wants exactly
 * one, like one reverse proxy's setup out of five. GitHub hides the markers
 * and shows plain headings. */
const TABS_START = '<!-- tabs -->'
const TABS_END = '<!-- /tabs -->'

type Part = { markdown: string } | { tabs: Tab[] }
type Tab = { title: string; markdown: string }

/** `body` cut into plain markdown and the tab groups in it. A heading line
 * inside a code block is left alone - a YAML comment is a `#` too. */
function partsOf(body: string): Part[] {
  const parts: Part[] = []
  let plain: string[] = []
  let tabs: { title: string; lines: string[] }[] | null = null
  let tabLevel = 0
  let fenced = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const marker = fenced ? null : line.trim()
    if (marker === TABS_START && !tabs) {
      if (plain.length) parts.push({ markdown: plain.join('\n') })
      plain = []
      tabs = []
      tabLevel = 0
      continue
    }
    if (marker === TABS_END && tabs) {
      parts.push({
        tabs: tabs.map((tab) => ({ title: tab.title, markdown: tab.lines.join('\n') })),
      })
      tabs = null
      continue
    }
    if (!tabs) {
      plain.push(line)
      continue
    }
    const heading = fenced ? null : line.match(/^(#{1,6}) +(.+?)\s*$/)
    if (heading && (!tabLevel || heading[1]!.length === tabLevel)) {
      tabLevel = heading[1]!.length
      tabs.push({ title: heading[2]!, lines: [] })
    } else {
      tabs.at(-1)?.lines.push(line)
    }
  }
  if (plain.length) parts.push({ markdown: plain.join('\n') })
  return parts
}

/** A tab group as plain HTML: the dialog switches the tabs itself (see
 * HelpDialog.vue's onContentClick), since what markdown-it renders is put
 * in with v-html. Each tab keeps the id GitHub gives its heading, so a link
 * to one still lands on it - and opens it. */
function renderTabs(part: Extract<Part, { tabs: Tab[] }>, env: RenderEnv): string {
  const escape = md.utils.escapeHtml
  const tabs = part.tabs.map((tab) => ({ id: env.nextId(tab.title), title: tab.title, tab }))
  const panels = tabs.map(({ id, tab }) => ({ id, html: md.render(tab.markdown, env) }))
  let html = '<div class="help-tabs"><div class="help-tabs__list" role="tablist">'
  tabs.forEach(({ id, title }, i) => {
    html +=
      `<button type="button" role="tab" class="help-tabs__tab" id="${escape(id)}" ` +
      `aria-controls="${escape(id)}-panel" aria-selected="${i === 0}" data-help-tab>` +
      `${escape(title)}</button>`
  })
  html += '</div>'
  panels.forEach(({ id, html: panel }, i) => {
    html +=
      `<div class="help-tabs__panel" role="tabpanel" id="${escape(id)}-panel" ` +
      `aria-labelledby="${escape(id)}"${i === 0 ? '' : ' hidden'}>${panel}</div>`
  })
  return `${html}</div>`
}

export function renderHelpPage(page: HelpPage): string {
  const env: RenderEnv = { page, nextId: headingIds() }
  return partsOf(page.body)
    .map((part) => ('tabs' in part ? renderTabs(part, env) : md.render(part.markdown, env)))
    .join('')
}
