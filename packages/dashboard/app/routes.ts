import { type RouteConfig, index, route } from '@react-router/dev/routes'

export default [
  index('routes/_index.tsx'),
  route('jobs', 'routes/jobs.tsx'),
  route('queues', 'routes/queues._index.tsx'),
  route('queues/create', 'routes/queues.create.tsx'),
  route('queues/:name', 'routes/queues.$name.tsx'),
  route('queues/:name/jobs/:jobId', 'routes/queues.$name.jobs.$jobId.tsx'),
  route('schedules', 'routes/schedules.tsx'),
  route('schedules/:name/:key', 'routes/schedules.$name.$key.tsx'),
  route('schedules/new', 'routes/schedules.new.tsx'),
  route('search', 'routes/search.tsx'),
  route('send', 'routes/send.tsx'),
  route('warnings', 'routes/warnings.tsx'),
] satisfies RouteConfig
