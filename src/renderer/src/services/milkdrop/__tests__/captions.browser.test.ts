// The caption is read from Butterchurn's internals (see captions.ts), which
// only a real renderer shows: a version that moved them would show no
// captions without a single error.
import { describe, expect, it } from 'vitest'
import { butterchurn } from '@/services/milkdrop/butterchurn'
import { currentCaption } from '../captions'

const SAYS_SECOND = {
  baseVals: { decay: 1, wave_a: 0, mv_a: 0, ob_size: 0, ib_size: 0 },
  shapes: [],
  waves: [],
  init_eqs_str: '',
  frame_eqs_str: 'a.q32=2;',
  pixel_eqs_str: '',
  warp: 'shader_body { ret = texture(sampler_main, uv).rgb; }',
  comp: 'shader_body { ret = texture(sampler_main, uv).rgb; }',
}

describe('currentCaption', () => {
  it('hears what the preset on screen set in its last frame', () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 16
    const visualizer = butterchurn.createVisualizer(new OfflineAudioContext(2, 1, 44100), canvas, {
      width: 16,
      height: 16,
      pixelRatio: 1,
    })
    visualizer.loadPreset(SAYS_SECOND, 0)
    visualizer.render()
    expect(currentCaption(visualizer, ['first', 'second'])).toBe('second')
  })
})
