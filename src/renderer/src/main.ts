import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'

import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import { emitter } from './emitter'
import { beaconTheme } from './plugins/theme'

const vuetify = createVuetify({
  components,
  directives,
  theme: beaconTheme,
})

document.documentElement.setAttribute('lang', i18n.global.locale as unknown as string)

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(vuetify)
app.use(i18n)
app.config.globalProperties.$emitter = emitter

app.mount('#app')
