import { normalize } from '../stringMatch'
import { rankByMatch } from '../textSearch'
import { HELP_PAGES, renderHelpPage, type HelpPage } from './docs'

/** One heading of a page and the text under it, down to the next heading:
 * what a search finds and the contents list jumps to. */
export interface HelpSection {
  page: string
  pageTitle: string
  /** null for the text above the page's first heading. */
  anchor: string | null
  heading: string
  /** 2 for a page's main sections (a FAQ question), deeper for the rest. */
  level: number
  text: string
}

export interface HelpSearchResult {
  section: HelpSection
  /** A short piece of the text around the first word that matched. */
  snippet: string
}

/** A highlighted run of text: `hit` where a query word matched. */
export interface HelpTextRun {
  text: string
  hit: boolean
}

const SECTION_HEADING = 'h2, h3, h4, [role="tab"]'

/** The page as the dialog shows it, cut at its headings. Read from the
 * rendered HTML rather than the markdown so a section's anchor is exactly
 * the id the dialog scrolls to - tabs and repeated headings included. A tab
 * panel's text belongs to its tab, although all the tabs come first. */
function sectionsOf(page: HelpPage): HelpSection[] {
  const doc = new DOMParser().parseFromString(renderHelpPage(page), 'text/html')
  const section = (anchor: string | null, heading: string, level: number) => ({
    page: page.id,
    pageTitle: page.title,
    anchor,
    heading,
    level,
    parts: [] as string[],
  })
  const sections = [section(null, page.title, 1)]
  const byAnchor = new Map<string, (typeof sections)[number]>()
  let current = sections[0]!
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.parentElement?.closest(SECTION_HEADING)) current.parts.push(node.textContent ?? '')
      continue
    }
    const element = node as Element
    if (element.matches(SECTION_HEADING) && element.id) {
      const level = element.matches('[role="tab"]') ? 5 : Number(element.tagName.slice(1))
      current = section(element.id, element.textContent?.trim() ?? '', level)
      sections.push(current)
      byAnchor.set(element.id, current)
    } else if (element.matches('[role="tabpanel"]')) {
      current = byAnchor.get(element.getAttribute('aria-labelledby') ?? '') ?? current
    }
  }
  return sections
    .map(({ parts, ...rest }) => ({ ...rest, text: parts.join(' ').replace(/\s+/g, ' ').trim() }))
    .filter((entry) => entry.anchor !== null || entry.text)
}

const sectionCache = new Map<string, HelpSection[]>()

/** Parsed on first use: nobody pays for it who never opens the help. */
export function helpSections(page: HelpPage): HelpSection[] {
  let sections = sectionCache.get(page.id)
  if (!sections) {
    sections = sectionsOf(page)
    sectionCache.set(page.id, sections)
  }
  return sections
}

/** The page's main headings, in order, for the contents list. */
export function tableOfContents(page: HelpPage): HelpSection[] {
  return helpSections(page).filter((section) => section.level === 2)
}

// A heading is what a reader scans for, so a word there counts most; the
// page title narrows ("sonos" on the Playback page) without deciding alone.
const HEADING_WEIGHT = 3
const PAGE_TITLE_WEIGHT = 1.5
const MAX_RESULTS = 30
// Characters of context kept before and after the first hit in a snippet.
const SNIPPET_BEFORE = 50
const SNIPPET_LENGTH = 160

function queryWords(query: string): string[] {
  return normalize(query).split(' ').filter(Boolean)
}

/** Around the first query word found in `text`, cut at word boundaries. The
 * start of the text when only the heading matched. */
export function snippetFor(text: string, query: string): string {
  const lower = text.toLowerCase()
  const hits = queryWords(query)
    .map((word) => lower.indexOf(word))
    .filter((index) => index >= 0)
  const first = hits.length ? Math.min(...hits) : 0
  let start = Math.max(0, first - SNIPPET_BEFORE)
  if (start > 0) start = text.indexOf(' ', start) + 1 || start
  let end = Math.min(text.length, start + SNIPPET_LENGTH)
  if (end < text.length) end = text.lastIndexOf(' ', end) > start ? text.lastIndexOf(' ', end) : end
  return `${start > 0 ? '… ' : ''}${text.slice(start, end)}${end < text.length ? ' …' : ''}`
}

/** Every section answering `query`, best first: each word has to be found
 * somewhere in the heading, the page title or the text, as the library's
 * filter fields match (a misspelled long word still counts). */
export function searchHelp(query: string): HelpSearchResult[] {
  if (!queryWords(query).length) return []
  const sections = HELP_PAGES.flatMap(helpSections)
  return rankByMatch(sections, query, (section) => [
    { text: section.heading, weight: HEADING_WEIGHT },
    { text: section.pageTitle, weight: PAGE_TITLE_WEIGHT },
    { text: section.text },
  ])
    .slice(0, MAX_RESULTS)
    .map((section) => ({ section, snippet: snippetFor(section.text, query) }))
}

/** `text` split into runs, the query's words marked, for showing in a
 * result where it matched. Case-insensitive; a word found only as a
 * misspelling has nothing to mark. The words are normalised to letters and
 * digits, so none of them can mean anything in the pattern. */
export function highlightRuns(text: string, query: string): HelpTextRun[] {
  const words = queryWords(query)
  if (!words.length) return [{ text, hit: false }]
  const pattern = new RegExp(`(${words.join('|')})`, 'gi')
  return text
    .split(pattern)
    .filter(Boolean)
    .map((run) => ({ text: run, hit: words.includes(run.toLowerCase()) }))
}
