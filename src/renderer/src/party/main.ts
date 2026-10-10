import '../assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { createVuetify } from 'vuetify'

import PartyGuestApp from './PartyGuestApp.vue'
import { i18n } from '../i18n'
import { emitter } from '../emitter'
import { beaconTheme } from '../plugins/theme'

// connect puts a fresh nonce into this meta tag for every page it serves
// and allows exactly that one inline <style> in its CSP (routes/party.py's
// _page_response) - the one Vuetify writes its theme into.
const cspNonce =
  document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? undefined

const vuetify = createVuetify({
  theme: { ...beaconTheme, cspNonce },
})

document.documentElement.setAttribute('lang', i18n.global.locale as unknown as string)

const app = createApp(PartyGuestApp)
app.use(createPinia())
app.use(vuetify)
app.use(i18n)
// VisualizerBars reports reduced motion through the app's event bus.
app.config.globalProperties.$emitter = emitter
app.mount('#app')
