import neostandard from 'neostandard'

const config = neostandard({
  ts: true,
  env: ['mocha'],
  ignores: neostandard.resolveIgnoresFromGitignore(),
  noJsx: true
})

export default config
