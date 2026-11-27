import { describe, expect, it, vi } from 'vitest'
import { createBuildCheck } from '../buildCheck'
import { buildIdOf } from '../../../../../vite.build-id'

function setup(deployed: (string | null)[], ownId = 'old') {
  let clock = 0
  const fetchDeployedId = vi.fn(async () => deployed.shift() ?? null)
  const announce = vi.fn()
  const buildCheck = createBuildCheck({ ownId, fetchDeployedId, announce, now: () => clock })
  return {
    buildCheck,
    fetchDeployedId,
    announce,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('createBuildCheck', () => {
  it('stays quiet while the deployed build is the one running', async () => {
    const { buildCheck, announce } = setup(['old'])
    await buildCheck.check()
    expect(announce).not.toHaveBeenCalled()
  })

  it('announces a different deployed build', async () => {
    const { buildCheck, announce } = setup(['new'])
    await buildCheck.check()
    expect(announce).toHaveBeenCalledTimes(1)
  })

  it('concludes nothing when the build id cannot be read', async () => {
    const { buildCheck, announce } = setup([null, 'new', null])
    await buildCheck.check()
    expect(announce).not.toHaveBeenCalled()
    await buildCheck.check(true)
    await buildCheck.check(true)
    expect(announce).toHaveBeenCalledTimes(1)
  })

  it('announces the same new build only once, but a newer one again', async () => {
    const { buildCheck, announce, advance } = setup(['new', 'new', 'newer'])
    await buildCheck.check()
    advance(120_000)
    await buildCheck.check()
    expect(announce).toHaveBeenCalledTimes(1)
    advance(120_000)
    await buildCheck.check()
    expect(announce).toHaveBeenCalledTimes(2)
  })

  it('does not ask again right after a check, unless forced', async () => {
    const { buildCheck, fetchDeployedId } = setup(['old', 'old'])
    await buildCheck.check()
    await buildCheck.check()
    expect(fetchDeployedId).toHaveBeenCalledTimes(1)
    await buildCheck.check(true)
    expect(fetchDeployedId).toHaveBeenCalledTimes(2)
  })

  it('repeats an announced build when something has already failed to load', async () => {
    const { buildCheck, announce } = setup(['new', 'new'])
    await buildCheck.check()
    await buildCheck.check(true)
    expect(announce).toHaveBeenCalledTimes(2)
  })
})

describe('buildIdOf', () => {
  const files = ['assets/index-abc.js', 'assets/index-def.css', 'index.html']

  it('is the same for the same files in any order', () => {
    expect(buildIdOf([...files].reverse())).toBe(buildIdOf(files))
  })

  it('changes when an emitted file changes', () => {
    expect(buildIdOf(['assets/index-xyz.js', 'assets/index-def.css', 'index.html'])).not.toBe(
      buildIdOf(files),
    )
  })

  it('ignores the files that carry the id themselves', () => {
    expect(buildIdOf([...files, 'build.json', 'party.html'])).toBe(buildIdOf(files))
  })
})
