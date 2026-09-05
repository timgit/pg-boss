import { route } from '@react-router/dev/routes'

// Config-time half of a fixture overlay. Route definitions are pure data, and
// must not use `~` imports — React Router's config loader cannot resolve them.
export default [
  route('pro-demo', 'pro/routes/demo.tsx'),
]
