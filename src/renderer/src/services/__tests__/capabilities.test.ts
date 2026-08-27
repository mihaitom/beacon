import { describe, expect, it } from 'vitest'
import { capabilitiesFor } from '../capabilities'

/** The one place that decides which controls a given server type gets to
 * show. A wrong value here is a dead-end button (or a hidden feature that
 * would have worked), so each of these pins a claim the bridges actually
 * have to back up. */
describe('capabilitiesFor', () => {
  it('gives an unknown server type the full Subsonic set', () => {
    // Navidrome and anything else Subsonic-compatible share one path, and
    // a server type nobody taught this about is far likelier to be one of
    // those than a bridge with holes in it.
    expect(capabilitiesFor('subsonic')).toEqual(capabilitiesFor('something-else'))
    expect(capabilitiesFor('subsonic').favorites).toBe(true)
  })

  it('hides favorites only on Plex, whose API has no boolean favorite', () => {
    expect(capabilitiesFor('plex').favorites).toBe(false)
    expect(capabilitiesFor('jellyfin').favorites).toBe(true)
    expect(capabilitiesFor('subsonic').favorites).toBe(true)
  })

  it('hides star ratings only on Jellyfin, which has no rating scale', () => {
    expect(capabilitiesFor('jellyfin').personalRating).toBe(false)
    expect(capabilitiesFor('plex').personalRating).toBe(true)
  })

  it("asks for the file's own lyrics wherever a bridge can answer", () => {
    // All three are bridged now — Jellyfin's /Audio/{id}/Lyrics and Plex's
    // own lyric stream on the track. The flag stays because it decides
    // whether the request is worth making at all.
    expect(capabilitiesFor('subsonic').fileLyrics).toBe(true)
    expect(capabilitiesFor('jellyfin').fileLyrics).toBe(true)
    expect(capabilitiesFor('plex').fileLyrics).toBe(true)
  })

  it('offers a library rescan on every server type, to an admin', () => {
    // All three are bridged now: Navidrome natively, Jellyfin onto its
    // library-scan task, Plex onto a refresh of the music section.
    expect(capabilitiesFor('subsonic', true).libraryScan).toBe(true)
    expect(capabilitiesFor('jellyfin', true).libraryScan).toBe(true)
    expect(capabilitiesFor('plex', true).libraryScan).toBe(true)
  })

  it('takes the rescan away from an account that is not an admin', () => {
    // Every one of them reserves a scan for administrators — Navidrome
    // marks startScan adminOnly in its own route table, Jellyfin's API
    // requires elevation, Plex needs the server's owner. A non-admin
    // pressing the button could only ever get an error back.
    expect(capabilitiesFor('subsonic', false).libraryScan).toBe(false)
    expect(capabilitiesFor('jellyfin', false).libraryScan).toBe(false)
    expect(capabilitiesFor('plex', false).libraryScan).toBe(false)
  })

  it('leaves the rescan alone while the server has not said either way', () => {
    // Not every OpenSubsonic-compatible server answers getUser.view.
    // Hiding a button that would have worked is worse than showing one
    // that might be refused.
    expect(capabilitiesFor('subsonic', null).libraryScan).toBe(true)
    expect(capabilitiesFor('subsonic').libraryScan).toBe(true)
  })

  it('changes nothing but the rescan, whatever the account is', () => {
    const { libraryScan: _admin, ...adminRest } = capabilitiesFor('subsonic', true)
    const { libraryScan: _plain, ...plainRest } = capabilitiesFor('subsonic', false)

    expect(adminRest).toEqual(plainRest)
  })
})
