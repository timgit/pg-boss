/* Hand-rolled tokenizer for TS / SQL / JSON.
   No dependencies: the tutorial has to run straight off the filesystem.

   Tokens are produced from the RAW text and escaped only on emit — escaping first and
   pattern-matching after would corrupt on the &amp; / &lt; it just introduced.
   No token ever spans a newline, so the emitter can slice output into lines safely. */
(function (global) {
  const PGB = global.PGB = global.PGB || {}

  const TS_KEYWORDS = new Set([
    'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'constructor',
    'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally',
    'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface',
    'is', 'keyof', 'let', 'new', 'of', 'private', 'protected', 'public', 'readonly', 'return',
    'satisfies', 'set', 'static', 'super', 'switch', 'this', 'throw', 'try', 'type', 'typeof',
    'var', 'while', 'yield'
  ])

  const TS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])

  const TS_TYPES = new Set([
    'any', 'bigint', 'boolean', 'never', 'number', 'object', 'string', 'symbol', 'unknown', 'void'
  ])

  const SQL_KEYWORDS = new Set([
    'add', 'all', 'alter', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'attach', 'begin', 'between',
    'by', 'cascade', 'case', 'cast', 'check', 'coalesce', 'columns', 'commit', 'concurrently',
    'conflict', 'constraint', 'create', 'declare', 'default', 'deferrable', 'delete', 'desc',
    'distinct', 'do', 'drop', 'else', 'end', 'except', 'execute', 'exists', 'filter', 'for', 'foreign',
    'format', 'from', 'full', 'function', 'grant', 'group', 'having', 'if', 'ilike', 'immutable', 'in',
    'include', 'index', 'inner', 'insert', 'intersect', 'into', 'is', 'join', 'key', 'language',
    'lateral', 'left', 'like', 'limit', 'list', 'locked', 'loop', 'nothing', 'not', 'notify', 'null',
    'nulls', 'of', 'offset', 'on', 'only', 'or', 'order', 'outer', 'over', 'partition', 'plpgsql',
    'primary', 'range', 'raise', 'references', 'rename', 'replace', 'returning', 'returns',
    'right', 'rollback', 'row', 'schema', 'select', 'set', 'share', 'skip', 'table', 'temp', 'then',
    'to', 'transaction', 'trigger', 'true', 'false', 'union', 'unique', 'update', 'using', 'values',
    'view', 'when', 'where', 'while', 'with', 'without'
  ])

  const SQL_TYPES = new Set([
    'bigint', 'bool', 'boolean', 'bytea', 'date', 'float8', 'int', 'int4', 'int8', 'integer',
    'interval', 'json', 'jsonb', 'numeric', 'record', 'text', 'timestamp', 'timestamptz', 'uuid',
    'varchar', 'void', 'zone'
  ])

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
  const esc = (s) => s.replace(/[&<>]/g, (c) => ESC[c])

  function tokenize (src, lang) {
    const out = []
    const sql = lang === 'sql'
    const json = lang === 'json'
    const n = src.length
    let i = 0

    // Split on newlines so no token ever straddles a line.
    const push = (type, text) => {
      if (!text) return
      const parts = text.split('\n')
      for (let k = 0; k < parts.length; k++) {
        if (k > 0) out.push({ type: 'nl', text: '\n' })
        if (parts[k]) out.push({ type, text: parts[k] })
      }
    }

    const isWord = (c) => c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c === '_' || c >= '0' && c <= '9'

    // A backtick template in TS is usually a SQL builder, so its literal chunks are emitted as
    // plain text and only the ${…} interpolations are coloured — a wall of string-green would
    // make every plans.ts excerpt unreadable.
    const scanTemplate = () => {
      push('punct', '`')
      i++
      let chunk = ''
      while (i < n) {
        const c = src[i]
        if (c === '\\') { chunk += src.substr(i, 2); i += 2; continue }
        if (c === '`') { break }
        if (c === '$' && src[i + 1] === '{') {
          push('plain', chunk)
          chunk = ''
          const start = i
          let depth = 0
          while (i < n) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') { depth--; if (depth === 0) { i++; break } }
            i++
          }
          push('type', src.slice(start, i))
          continue
        }
        chunk += c
        i++
      }
      push('plain', chunk)
      if (src[i] === '`') { push('punct', '`'); i++ }
    }

    const scanQuoted = (quote) => {
      const start = i
      i++
      while (i < n) {
        const c = src[i]
        if (c === '\\' && !sql) { i += 2; continue }
        if (c === quote) {
          if (sql && src[i + 1] === quote) { i += 2; continue } // '' is an escaped quote in SQL
          i++
          break
        }
        i++
      }
      push('string', src.slice(start, i))
    }

    while (i < n) {
      const c = src[i]

      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        let j = i
        while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++
        push('plain', src.slice(i, j))
        i = j
        continue
      }

      if (sql && c === '-' && src[i + 1] === '-') {
        let j = src.indexOf('\n', i)
        if (j === -1) j = n
        push('comment', src.slice(i, j))
        i = j
        continue
      }

      if (!sql && !json && c === '/' && src[i + 1] === '/') {
        let j = src.indexOf('\n', i)
        if (j === -1) j = n
        push('comment', src.slice(i, j))
        i = j
        continue
      }

      if (!json && c === '/' && src[i + 1] === '*') {
        let j = src.indexOf('*/', i + 2)
        j = j === -1 ? n : j + 2
        push('comment', src.slice(i, j))
        i = j
        continue
      }

      // plpgsql dollar quoting: $$ … $$ or $tag$ … $tag$
      if (sql && c === '$') {
        const tag = /^\$[A-Za-z_]*\$/.exec(src.slice(i))
        if (tag) {
          const close = src.indexOf(tag[0], i + tag[0].length)
          const end = close === -1 ? n : close + tag[0].length
          push('string', src.slice(i, end))
          i = end
          continue
        }
        if (src[i + 1] >= '0' && src[i + 1] <= '9') {
          let j = i + 1
          while (j < n && src[j] >= '0' && src[j] <= '9') j++
          push('number', src.slice(i, j)) // $1, $2 — bind parameters
          i = j
          continue
        }
      }

      if (c === '`' && !sql && !json) { scanTemplate(); continue }
      if (c === "'" || c === '"') { scanQuoted(c); continue }

      if (c >= '0' && c <= '9') {
        let j = i
        while (j < n && /[0-9a-fA-FxX._]/.test(src[j])) j++
        push('number', src.slice(i, j))
        i = j
        continue
      }

      if (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c === '_') {
        let j = i
        while (j < n && isWord(src[j])) j++
        const word = src.slice(i, j)
        const lower = word.toLowerCase()
        let k = j
        while (k < n && (src[k] === ' ' || src[k] === '\t')) k++
        const callish = src[k] === '('

        let type = 'plain'
        if (json) {
          type = (word === 'true' || word === 'false' || word === 'null') ? 'keyword' : 'plain'
        } else if (sql) {
          if (SQL_KEYWORDS.has(lower)) type = 'keyword'
          else if (SQL_TYPES.has(lower)) type = 'type'
          else if (callish) type = 'fn'
        } else {
          if (TS_KEYWORDS.has(word)) type = 'keyword'
          else if (TS_LITERALS.has(word)) type = 'number'
          else if (TS_TYPES.has(word)) type = 'type'
          else if (callish) type = 'fn'
          else if (/^[A-Z]/.test(word)) type = 'type'
        }

        push(type, word)
        i = j
        continue
      }

      push('punct', c)
      i++
    }

    return out
  }

  /* Returns one HTML string per line of `text`. */
  function highlightLines (text, lang) {
    const known = lang === 'ts' || lang === 'sql' || lang === 'json'
    if (!known) return text.split('\n').map(esc)

    const lines = ['']
    for (const tok of tokenize(text, lang)) {
      if (tok.type === 'nl') { lines.push(''); continue }
      const body = esc(tok.text)
      lines[lines.length - 1] += tok.type === 'plain' ? body : `<span class="tok-${tok.type}">${body}</span>`
    }
    return lines
  }

  PGB.highlightLines = highlightLines
  PGB.escapeHtml = esc
})(window)
