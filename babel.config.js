const presets = [
  [
    '@babel/env', { targets: { node: true } }
  ]
]

module.exports = { presets, plugins: ['istanbul'] }
