import { GITHUB_REPO } from './project'
import { isNewer } from './updateCheck'

export type ChangelogEntry = {
  version: string
  date: string
  /** Raw markdown for this version's whole section (everything below its
   * `## [x] - y` heading down to the next one) — kept as-is rather than
   * flattened into a custom section/item model, so headings, nested lists,
   * bold text, links and blockquotes all render through markdown-it
   * unchanged instead of being lost. */
  body: string
}

/** What is on its way: the development branch's `[Unreleased]` section and
 * every release published since the running version. */
export type UpcomingChanges = {
  unreleased: string
  newer: ChangelogEntry[]
}

/** The development branch, not main: main only ever holds what is released,
 * which the bundled CHANGELOG.md already has up to this version. */
const UPCOMING_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/development/CHANGELOG.md`

/** The released sections, newest first. `[Unreleased]` has no date in its
 * heading and is left out - see unreleasedSection(). */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: (ChangelogEntry & { lines: string[] })[] = []
  let current: (ChangelogEntry & { lines: string[] }) | null = null

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const versionMatch = line.match(/^##\s+\[(.+?)\]\s+-\s+(.+)$/)
      current = versionMatch
        ? { version: versionMatch[1] ?? '', date: versionMatch[2] ?? '', body: '', lines: [] }
        : null
      if (current) entries.push(current)
      continue
    }
    current?.lines.push(line)
  }

  return entries.map(({ version, date, lines }) => ({
    version,
    date,
    body: lines.join('\n').trim(),
  }))
}

export function unreleasedSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+\[Unreleased\]/i.test(line))
  if (start < 0) return ''
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim()
}

export function upcomingFrom(markdown: string, currentVersion: string): UpcomingChanges {
  return {
    unreleased: unreleasedSection(markdown),
    newer: parseChangelog(markdown).filter((entry) => isNewer(entry.version, currentVersion)),
  }
}

/** Fetched on demand only, when someone asks for it in the release notes
 * dialog. Throws on any failure: the dialog says so instead of showing an
 * empty section that would read as "nothing planned". */
export async function fetchUpcoming(currentVersion: string): Promise<UpcomingChanges> {
  const response = await fetch(UPCOMING_URL, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`Changelog request failed: ${response.status}`)
  return upcomingFrom(await response.text(), currentVersion)
}
