import { reactRouter } from '@react-router/dev/vite'
import { reactRouterHonoServer } from 'react-router-hono-server/dev'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    tailwindcss(),
    reactRouterHonoServer({ runtime: 'node' }),
    reactRouter(),
  ],
  resolve: {
    alias: {
      '~': '/app',
      'pg-boss': resolve(__dirname, '../../src'),
    },
  },
})
