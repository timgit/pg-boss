import { type RouteConfig, index, route } from '@react-router/dev/routes'

export default [
  index('routes/_index.tsx'),
  route('queues', 'routes/queues._index.tsx'),
  route('queues/:name', 'routes/queues.$name.tsx'),
  route('queues/:name/jobs/:jobId', 'routes/queues.$name.jobs.$jobId.tsx'),
  route('warnings', 'routes/warnings.tsx'),
] satisfies RouteConfig
