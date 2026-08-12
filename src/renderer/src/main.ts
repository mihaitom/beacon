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

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'beacon',
    themes: {
      // "Beacon" — a light that guides you back into your music. Warm
      // amber signal-light against deep night-navy, not Vuetify's default
      // blue/dark palette.
      beacon: {
        dark: true,
        colors: {
          background: '#12141C',
          surface: '#1A1D27',
          'surface-bright': '#232733',
          primary: '#F5A94E',
          secondary: '#5B84B1',
          error: '#E5484D',
          warning: '#F2A93B',
          info: '#5B84B1',
          success: '#5FB489',
        },
      },
    },
  },
})

document.documentElement.setAttribute('lang', i18n.global.locale as unknown as string)

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(vuetify)
app.use(i18n)
app.config.globalProperties.$emitter = emitter

app.mount('#app')
