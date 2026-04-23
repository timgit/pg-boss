import { defineConfig } from 'vitepress'
import pkg from '../../package.json'

export default defineConfig({
  title: 'pg-boss',
  description: 'Queueing jobs in Postgres from Node.js like a boss',
  themeConfig: {
    search: {
      provider: 'local'
    },
    nav: [
      { text: 'Guide', link: '/introduction' },
      { text: 'API', link: '/api/constructor' },
      {
        text: pkg.version,
        items: [
          { text: 'Releases', link: 'https://github.com/timgit/pg-boss/releases' },
          { text: 'npm', link: 'https://www.npmjs.com/package/pg-boss' }
        ]
      },
      { text: 'GitHub', link: 'https://github.com/timgit/pg-boss' }
    ],
    sidebar: [
      { text: 'Introduction', link: '/introduction' },
      { text: 'Install', link: '/install' },
      { text: 'CLI', link: '/cli' },
      { text: 'Dashboard', link: '/dashboard' },
      {
        text: 'API',
        items: [
          { text: 'Constructor', link: '/api/constructor' },
          { text: 'Events', link: '/api/events' },
          { text: 'Operations', link: '/api/ops' },
          { text: 'Queues', link: '/api/queues' },
          { text: 'Jobs', link: '/api/jobs' },
          { text: 'Scheduling', link: '/api/scheduling' },
          { text: 'PubSub', link: '/api/pubsub' },
          { text: 'Workers', link: '/api/workers' },
          { text: 'Testing', link: '/api/testing' },
          { text: 'Utils', link: '/api/utils' }
        ]
      },
      {
        text: 'SQL',
        items: [
          { text: 'Job Table', link: '/sql/job-table' },
          { text: 'Queue Functions', link: '/sql/queue-functions' },
          { text: 'Warning Table', link: '/sql/warning-table' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/timgit/pg-boss' }
    ]
  }
})
