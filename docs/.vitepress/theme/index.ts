import DefaultTheme from 'vitepress/theme'
import { useRoute, type Theme } from 'vitepress'
import mediumZoom, { type Zoom } from 'medium-zoom'
import { nextTick, onMounted, watch } from 'vue'
import './custom.css'

// Images in a page open full size on a click, except those that are links. Both copies of a
// light/dark screenshot are attached; only the one showing can be clicked.
const ZOOMABLE = '.vp-doc img:not(a img)'

export default {
  extends: DefaultTheme,
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
