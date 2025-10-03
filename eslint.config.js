const neostandard = require('neostandard')
const { resolveIgnoresFromGitignore } = neostandard

const config = neostandard({
  ts: true,
  env: ['mocha'],
  ignores: [
    ...resolveIgnoresFromGitignore(),
  ],
})

module.exports = config
