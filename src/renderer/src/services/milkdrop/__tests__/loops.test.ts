import { describe, expect, it } from 'vitest'
import { keepLoopsRolled, keepLoopsRolledIn } from '../loops'

describe('keepLoopsRolledIn', () => {
  it('starts every loop from the uniform-backed zero', () => {
    const out = keepLoopsRolledIn(
      'float f() { for (int i = 0; i < 6; i++) {} }\n shader_body { for(int k=1;k<=10;k++){} }',
    )
    expect(out).toContain('for (int i = (0) + BEACON_ZERO;')
    expect(out).toContain('for (int k = (1) + BEACON_ZERO;')
    expect(out.startsWith('#define BEACON_ZERO int(min(frame, 0.0))\n')).toBe(true)
  })

  it('leaves a shader without loops as it is', () => {
    const shader = 'shader_body { ret = vec3(1.0); }'
    expect(keepLoopsRolledIn(shader)).toBe(shader)
  })

  it('can run twice in a row, as for consecutive presets', () => {
    const shader = 'shader_body { for (int i = 0; i < 2; i++) {} }'
    expect(keepLoopsRolledIn(shader)).toBe(keepLoopsRolledIn(shader))
  })
})

describe('keepLoopsRolled', () => {
  it('hands back the same preset when nothing changes', () => {
    const preset = { warp: '', comp: 'shader_body { ret = vec3(0.0); }' }
    expect(keepLoopsRolled(preset)).toBe(preset)
  })
})
