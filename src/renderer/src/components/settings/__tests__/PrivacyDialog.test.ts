// The privacy dialog is only worth having if it is true, and the way it
// stops being true is quietly: a service gets added to the backend and
// nobody thinks to list it here. So the important test in this file is not
// that the dialog renders — it is the one that reads the source and checks
// that every outbound host it finds is accounted for.
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import PrivacyDialog from '../PrivacyDialog.vue'

const vuetify = createVuetify({ components, directives })
const ROOT = resolve(__dirname, '../../../../../..')

function mountDialog() {
  return mount(PrivacyDialog, {
    props: { modelValue: true },
    global: { plugins: [vuetify, i18n] },
    // v-dialog teleports its content out of the component tree.
    attachTo: document.body,
  })
}

/** Every .py under connect/, which is where all of the server's own
 * outbound calls live. */
function backendSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.venv' || entry.name === 'dist' || entry.name === 'build') continue
      // tests, and the build/dev tooling beside them: none of it ships,
      // and none of it runs while anyone is using Beacon.
      if (['__pycache__', 'tests', 'scripts', 'packaging'].includes(entry.name)) continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.py')) out.push(readFileSync(full, 'utf8'))
    }
  }
  walk(resolve(ROOT, 'connect'))
  return out
}

/** Hosts that are not a third-party service being called: this machine,
 * and the placeholder domains the code uses in examples. The user's own
 * media server never appears as a literal — it is a URL they configured. */
const NOT_A_SERVICE = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|.*\.example\.com|.*\.example|.*\.local)$/

/** Comments and docstrings stripped, so a link in prose is not mistaken
 * for a call. Deliberately a rule about *where* the URL is, not a list of
 * hosts to ignore — a whitelist would be the obvious way to make this test
 * pass while it quietly stopped meaning anything. */
function codeOnly(python: string): string {
  return (
    python
      // An XML namespace is an identifier, not an address — DIDL-Lite
      // metadata for Sonos and DLNA carries several, and none is fetched.
      .replace(/xmlns(?::[a-z]+)?="[^"]*"/g, '')
      .replace(/"""[\s\S]*?"""/g, '')
      .replace(/'''[\s\S]*?'''/g, '')
      .replace(/#.*$/gm, '')
  )
}

function outboundHosts(sources: string[]): Set<string> {
  const hosts = new Set<string>()
  for (const source of sources) {
    for (const match of codeOnly(source).matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
      const host = match[1]!
      if (!NOT_A_SERVICE.test(host)) hosts.add(host)
    }
  }
  return hosts
}

describe('PrivacyDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('accounts for every third-party host the backend calls out to', () => {
    // Read off the rendered dialog, not off the component's own constant —
    // a host listed in the data but never shown would pass a test written
    // against the data and tell a reader nothing.
    mountDialog()
    const shown = document.body.textContent ?? ''

    const missing = [...outboundHosts(backendSources())].filter((host) => !shown.includes(host))

    expect(missing, `not listed in the privacy dialog: ${missing.join(', ')}`).toEqual([])
  })

  it('accounts for the ones the app itself calls out to', () => {
    // The renderer reaches exactly one third-party host of its own; the
    // rest of its traffic goes to the Beacon server. A second one appearing
    // is precisely what this is here to notice.
    const source = readFileSync(resolve(ROOT, 'src/renderer/src/services/updateCheck.ts'), 'utf8')
    expect(source).toContain('api.github.com')

    mountDialog()
    expect(document.body.textContent).toContain('api.github.com')
  })

  it('says what each service is sent, not only that it is contacted', () => {
    mountDialog()
    const entries = document.querySelectorAll('.privacy-service')

    expect(entries.length).toBeGreaterThan(5)
    for (const entry of entries) {
      expect(entry.querySelector('.privacy-service__purpose')?.textContent?.trim()).toBeTruthy()
      expect(entry.querySelector('.privacy-service__sent')?.textContent?.trim()).toBeTruthy()
    }
  })

  it('says how the two builds differ, since the split above means less in one', () => {
    // In the desktop app the Beacon server runs on this same machine, so
    // the second section's requests leave from this address after all —
    // letting that read as a separation it is not would be the one
    // misleading thing in here.
    mountDialog()
    const note = document.querySelector('.privacy-note')

    expect(note?.textContent).toBeTruthy()
    expect(note?.textContent?.toLowerCase()).toContain('docker')
  })

  it('separates what this device contacts from what the server does', () => {
    // The distinction with the actual consequence: a request your server
    // makes never shows the far end your address.
    mountDialog()
    const groups = document.querySelectorAll('.privacy-group')

    expect(groups).toHaveLength(2)
    for (const group of groups) {
      // The rule for the whole section, in a block of its own: as an
      // ordinary paragraph it read as the first entry's own text, leaving
      // it unclear whether it applied to the rest.
      const rule = group.querySelector('.privacy-group__rule')
      expect(rule?.textContent?.trim()).toBeTruthy()
      expect(rule?.compareDocumentPosition(group.querySelector('.privacy-service')!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )
    }
  })

  it('names the setting that turns an optional service off', () => {
    // "Can be switched off somewhere" is not worth saying without saying
    // where — and only the services a setting really governs carry it.
    mountDialog()
    const chips = document.querySelectorAll('.privacy-service .v-chip')

    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) {
      expect(chip.textContent?.trim()).toBeTruthy()
    }
  })
})
