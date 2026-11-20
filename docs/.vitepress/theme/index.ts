import DefaultTheme from 'vitepress/theme'
import { useRoute, type Theme } from 'vitepress'
import mediumZoom, { type Zoom } from 'medium-zoom'
import { h, nextTick, onMounted, watch } from 'vue'
import './custom.css'

// Images in a page open full size on a click, except those that are links. Both copies of a
// light/dark screenshot are attached; only the one showing can be clicked.
const ZOOMABLE = '.vp-doc img:not(a img)'

const isPro = (path: string) => path === '/pro' || path.startsWith('/pro/')

export default {
  extends: DefaultTheme,
  // On the Pro pages, the site title reads "pg-boss Pro". The nav bar leads back to the pg-boss docs.
  Layout () {
    const route = useRoute()
    return h(DefaultTheme.Layout, null, {
      'nav-bar-title-after': () => isPro(route.path) ? h('span', { class: 'pro-site-title' }, 'Pro') : null,
    })
  },
  setup () {
    const route = useRoute()
    let zoom: Zoom | undefined

    // Created on mount, since medium-zoom needs the document; reattached after each page change.
    onMounted(() => {
      zoom = mediumZoom(ZOOMABLE, { background: 'var(--vp-c-bg)', margin: 24 })
    })
    watch(() => route.path, () => nextTick(() => {
      zoom?.detach()
      zoom?.attach(ZOOMABLE)
    }))
  },
} satisfies Theme
