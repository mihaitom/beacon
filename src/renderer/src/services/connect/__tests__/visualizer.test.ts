import { afterEach, describe, expect, it, vi } from 'vitest'
import { VisualizerEventSource } from '../visualizer'

const opened: string[] = []

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  constructor(url: string) {
    opened.push(url)
  }
  close(): void {}
}

describe('VisualizerEventSource', () => {
  afterEach(() => {
    opened.length = 0
    vi.unstubAllGlobals()
  })

  it('asks connect for the waveform only when told to', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const bars = new VisualizerEventSource('http://connect', 'tok', 'sess')
    const milkdrop = new VisualizerEventSource('http://connect', 'tok', 'sess', true)
    bars.start()
    milkdrop.start()
    bars.stop()
    milkdrop.stop()

    expect(new URL(opened[0]!).searchParams.has('waveform')).toBe(false)
    expect(new URL(opened[1]!).searchParams.get('waveform')).toBe('true')
  })
})
