// Code blocks in the help docs: a known language is highlighted, anything
// else stays plain text - and neither lets markup in the code through.
import { describe, expect, it } from 'vitest'
import { findHelpPage, renderHelpPage } from '../docs'
import { highlightCode } from '../codeHighlight'

describe('highlightCode', () => {
  it('highlights a bundled language', () => {
    expect(highlightCode('def f():\n    return 1', 'python')).toContain('hljs-keyword')
  })

  it('leaves an unknown or missing language to markdown-it', () => {
    expect(highlightCode('example.com {}', 'caddy')).toBe('')
    expect(highlightCode('x', '')).toBe('')
  })

  it('escapes markup inside the code', () => {
    const html = highlightCode('s = "<script>alert(1)</script>"', 'python')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('help pages', () => {
  it('render their python example highlighted', () => {
    const html = renderHelpPage(findHelpPage('reference/external-source-api'))
    expect(html).toContain('class="language-python"')
    expect(html).toContain('hljs-keyword')
  })
})
