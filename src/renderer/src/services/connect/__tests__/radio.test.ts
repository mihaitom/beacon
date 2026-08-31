import { describe, expect, it } from 'vitest'
import { radioFaviconUrl } from '../radio'

describe('radioFaviconUrl', () => {
  it('builds the plain homepage-only URL when nothing else is given', () => {
    const url = radioFaviconUrl('https://api.example', 'tok', 'https://station.example')
    expect(url).toBe(
      'https://api.example/radio-favicon?url=https%3A%2F%2Fstation.example&token=tok',
    )
  })

  it('adds min_size only when positive', () => {
    const url = radioFaviconUrl('https://api.example', 'tok', 'https://station.example', 32)
    expect(url).toContain('min_size=32')
  })

  it('adds the Radio Browser favicon hint when given', () => {
    const url = radioFaviconUrl(
      'https://api.example',
      'tok',
      'https://station.example',
      0,
      'https://cdn.example/icon.png',
    )
    expect(url).toContain('hint=https%3A%2F%2Fcdn.example%2Ficon.png')
  })

  it('omits the hint for a station that never had one', () => {
    const url = radioFaviconUrl('https://api.example', 'tok', 'https://station.example')
    expect(url).not.toContain('hint=')
  })

  it('omits the token entirely when there is none', () => {
    const url = radioFaviconUrl('https://api.example', '', 'https://station.example')
    expect(url).not.toContain('token')
  })

  it('omits url entirely and relies on the hint when there is no homepage', () => {
    const url = radioFaviconUrl('https://api.example', 'tok', '', 0, 'https://cdn.example/icon.png')
    expect(url).not.toContain('url=')
    expect(url).toContain('hint=https%3A%2F%2Fcdn.example%2Ficon.png')
  })
})
