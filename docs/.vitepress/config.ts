import { defineConfig } from 'vitepress'
import pkg from '../../package.json' with { type: 'json' }

export default defineConfig({
  title: 'pg-boss',
  description: 'Queueing jobs in Postgres from Node.js like a boss',
  base: '/',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: 'https://pgboss.io'
  },
  head: [
    ['meta', { name: 'theme-color', content: '#2f7cf6' }],
    ['script', {}, `(function(){
      var hash = window.location.hash;
      var pathname = window.location.pathname;
      // Legacy hash routes were served from both the github.io subpath and the root
      if((pathname === '/' || pathname === '/pg-boss/') && hash.startsWith('#/')){
        var path = hash.slice(2).split('?')[0];
        if(!path) return;
        if(path === 'sql') path = 'sql/job-table';
        window.location.replace('/' + path);
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
      { text: 'API', link: '/api/constructor', activeMatch: '/api/' },
      { text: 'Pro 🚀', link: '/pro/', activeMatch: '/pro/' },
      { text: 'Sponsors', link: '/sponsors' },
      {
        text: pkg.version,
        items: [
          { text: 'Releases', link: 'https://github.com/timgit/pg-boss/releases' },
          { text: 'npm', link: 'https://www.npmjs.com/package/pg-boss' }
        ]
      }
    ],
    sidebar: {
      '/pro/': [
        { text: 'Overview', link: '/pro/' },
        { text: 'Install and run', link: '/pro/install' },
        { text: 'Mount in your application', link: '/pro/mount' },
        { text: 'pg-boss versions', link: '/pro/versions' },
        {
          text: 'Pro Console',
          items: [
            { text: 'Overview', link: '/pro/overview' },
            { text: 'Queues', link: '/pro/queues' },
            { text: 'Status', link: '/pro/status' },
            { text: 'Instances', link: '/pro/instances' },
            { text: 'Jobs and queues', link: '/pro/changes' },
            { text: 'Operations', link: '/pro/operations' }
          ]
        },
        {
          text: 'Alerts',
          items: [
            { text: 'Alerts', link: '/pro/alerts' },
            { text: 'Alert rules', link: '/pro/alert-rules' },
            { text: 'Destinations', link: '/pro/destinations' }
          ]
        },
        {
          text: 'People and access',
          items: [
            { text: 'Accounts and groups', link: '/pro/accounts' },
            { text: 'Roles and access', link: '/pro/roles' },
            { text: 'Single sign-on', link: '/pro/sso' },
            { text: 'API tokens and service accounts', link: '/pro/api-tokens' },
            { text: 'Audit log', link: '/pro/audit-log' }
          ]
        },
        {
          text: 'Administration',
          items: [
            { text: 'Databases', link: '/pro/databases' },
            { text: 'Retention and secrets', link: '/pro/administration' },
            { text: 'License', link: '/pro/license' },
            { text: 'Network activity', link: '/pro/network' }
          ]
        },
        {
          text: 'Reference',
          items: [
            { text: 'Pro API', link: '/pro/api' },
            { text: 'Metrics', link: '/pro/metrics' },
            { text: 'Environment variables', link: '/pro/environment' },
            { text: 'Release notes', link: '/pro/releases' }
          ]
        },
        { text: 'pg-boss', link: '/introduction' }
      ],
      '/': [
        { text: 'Introduction', link: '/introduction' },
        { text: 'CLI', link: '/cli' },
        { text: 'Dashboard', link: '/dashboard' },
        { text: 'Proxy', link: '/proxy' },
        { text: 'Pro', link: '/pro/' },
        { text: 'Database Install', link: '/install' },
        { text: 'Database Backends', link: '/database-backends' },
        { text: 'OpenTelemetry', link: '/opentelemetry' },
        { text: 'Sponsors', link: '/sponsors' },
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
          collapsed: false,
          items: [
            { text: 'Job Table', link: '/sql/job-table' },
            { text: 'Queue Functions', link: '/sql/queue-functions' },
            { text: 'Warning Table', link: '/sql/warning-table' },
            { text: 'Instance Table', link: '/sql/instance-table' }
          ]
        }
      ]
    },
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
