import neostandard, { resolveIgnoresFromGitignore } from 'neostandard'

export default neostandard({
  ts: true,
  env: ['mocha'],
  ignores: [
    ...resolveIgnoresFromGitignore(),
  ],
})
