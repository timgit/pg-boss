import { type RouteConfig, index, route } from '@react-router/dev/routes'
import { proRoutes } from './lib/pro-overlay'

/**
 * Passed to the overlay rather than concatenated with it: a Pro build may nest
 * these under a layout route that carries authorisation middleware, which is
 * not something an appended array can do.
 */
const freeRoutes = [
  index('routes/_index.tsx'),
  route('jobs', 'routes/jobs.tsx'),
  route('queues', 'routes/queues._index.tsx'),
  route('queues/create', 'routes/queues.create.tsx'),
  route('queues/:name', 'routes/queues.$name.tsx'),
  route('queues/:name/metrics', 'routes/queues.$name.metrics.tsx'),
  route('queues/:name/jobs/:jobId', 'routes/queues.$name.jobs.$jobId.tsx'),
  route('schedules', 'routes/schedules.tsx'),
  route('schedules/:name/:key', 'routes/schedules.$name.$key.tsx'),
  route('schedules/new', 'routes/schedules.new.tsx'),
  route('send', 'routes/send.tsx'),
  route('migrations', 'routes/migrations.tsx'),
  route('warnings', 'routes/warnings.tsx'),
]

export default (await proRoutes(freeRoutes)) satisfies RouteConfig
