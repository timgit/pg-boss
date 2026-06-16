import { defineConfig } from 'vitepress'
import pkg from '../../package.json'

export default defineConfig({
  title: 'pg-boss',
  description: 'Queueing jobs in Postgres from Node.js like a boss',
  base: '/pg-boss/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['script', {}, `(function(){
      var hash = window.location.hash;
      if(window.location.pathname === '/pg-boss/' && hash.startsWith('#/')){
        var path = hash.slice(2).split('?')[0];
        if(!path) return;
        if(path === 'sql') path = 'sql/job-table';
        window.location.replace('/pg-boss/' + path);
      }
    })()`]
  ],
  themeConfig: {
    outline: [2, 3],
    externalLinkIcon: true,
    search: {
      provider: 'local',
      options: {
        detailedView: true
      }
    },
    nav: [
      { text: 'Get Started', link: '/introduction' },
      { text: 'API', link: '/api/constructor' },
      {
        text: pkg.version,
        items: [
          { text: 'Releases', link: 'https://github.com/timgit/pg-boss/releases' },
          { text: 'npm', link: 'https://www.npmjs.com/package/pg-boss' }
        ]
      }
    ],
    sidebar: [
      { text: 'Introduction', link: '/introduction' },
      { text: 'Install', link: '/install' },
      { text: 'CLI', link: '/cli' },
      { text: 'Dashboard', link: '/dashboard' },
      { text: 'Proxy', link: '/proxy' },
      {
        text: 'API',
        collapsed: false,
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
          { text: 'Utils', link: '/api/utils' },
          { text: 'Adapters', link: '/api/adapters' }
        ]
      },
      {
        text: 'SQL',
        collapsed: true,
        items: [
          { text: 'Job Table', link: '/sql/job-table' },
          { text: 'Queue Functions', link: '/sql/queue-functions' },
          { text: 'Warning Table', link: '/sql/warning-table' }
        ]
      }
    ],
    editLink: {
      pattern: 'https://github.com/timgit/pg-boss/edit/master/docs/:path',
      text: 'Suggest changes to this page'
    },
    lastUpdated: {
      text: 'Last updated'
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/timgit/pg-boss' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/pg-boss' }
    ]
  }
})
