(function (global) {
  const PGB = global.PGB || {}
  const SLIDES = PGB.SLIDES || []
  const DIAGRAMS = PGB.DIAGRAMS || {}

  const KEY = 'pgboss-tutorial:'
  const $ = (id) => document.getElementById(id)

  const el = {
    prose: $('prose'),
    quizSlot: $('quiz-slot'),
    panels: $('panels'),
    paneProse: $('pane-prose'),
    paneCode: $('pane-code'),
    split: $('split'),
    gutter: $('gutter'),
    crumbChapter: $('crumb-chapter'),
    crumbTitle: $('crumb-title'),
    counter: $('counter'),
    progress: $('progress-fill'),
    dots: $('dots'),
    prev: $('btn-prev'),
    next: $('btn-next'),
    drawer: $('drawer'),
    toc: $('toc'),
    help: $('help')
  }

  function load (key, fallback) {
    try {
      const raw = global.localStorage.getItem(KEY + key)
      return raw === null ? fallback : JSON.parse(raw)
    } catch (err) {
      return fallback
    }
  }

  function save (key, value) {
    try {
      global.localStorage.setItem(KEY + key, JSON.stringify(value))
    } catch (err) { /* private mode / disabled storage is not worth failing over */ }
  }

  const state = {
    index: 0,
    visited: new Set(load('visited', [])),
    quiz: load('quiz', {}),
    ratio: load('split', 46)
  }

  /* ---------- rendering ---------- */

  function renderCodePanel (panel) {
    const wrap = document.createElement('div')
    wrap.className = 'panel'

    const head = document.createElement('div')
    head.className = 'panel-head'
    head.innerHTML =
      `<span class="path">${PGB.escapeHtml(panel.file || panel.label || '')}</span>` +
      (panel.lines ? `<span class="lines">:${PGB.escapeHtml(panel.lines)}</span>` : '') +
      '<span class="spacer"></span>'

    const copy = document.createElement('button')
    copy.className = 'copy-btn'
    copy.textContent = 'copy'
    copy.addEventListener('click', () => {
      const done = () => {
        copy.textContent = 'copied'
        copy.classList.add('done')
        global.setTimeout(() => { copy.textContent = 'copy'; copy.classList.remove('done') }, 1200)
      }
      if (global.navigator.clipboard) {
        global.navigator.clipboard.writeText(panel.text).then(done, () => { copy.textContent = 'failed' })
      } else {
        copy.textContent = 'failed'
      }
    })
    head.appendChild(copy)

    const start = panel.lines ? parseInt(String(panel.lines).split('-')[0], 10) : NaN
    const lines = PGB.highlightLines(panel.text.replace(/\n+$/, ''), panel.lang || 'ts')
    const rows = lines.map((html, k) => {
      const num = Number.isFinite(start) ? String(start + k) : ''
      return `<span class="row"><span class="ln">${num}</span><span class="lc">${html || ' '}</span></span>`
    }).join('')

    const pre = document.createElement('pre')
    pre.innerHTML = `<code>${rows}</code>`

    wrap.appendChild(head)
    wrap.appendChild(pre)
    if (panel.note) {
      const note = document.createElement('p')
      note.className = 'panel-note'
      note.innerHTML = panel.note
      wrap.appendChild(note)
    }
    return wrap
  }

  function renderSvgPanel (panel) {
    const wrap = document.createElement('div')
    wrap.className = 'panel'
    const box = document.createElement('div')
    box.className = 'panel-svg'
    box.innerHTML = DIAGRAMS[panel.name] || `<p class="panel-note">Missing diagram: ${PGB.escapeHtml(panel.name)}</p>`
    wrap.appendChild(box)
    if (panel.caption) {
      const cap = document.createElement('p')
      cap.className = 'panel-note'
      cap.innerHTML = panel.caption
      wrap.appendChild(cap)
    }
    return wrap
  }

  function renderQuiz (slide) {
    el.quizSlot.innerHTML = ''
    if (!slide.quiz) return

    const q = slide.quiz
    const box = document.createElement('div')
    box.className = 'quiz'
    box.innerHTML = `<div class="quiz-tag">Checkpoint</div><p class="quiz-q">${q.q}</p>`

    const explain = document.createElement('p')
    explain.className = 'quiz-explain'
    explain.innerHTML = q.explain
    explain.hidden = true

    const answered = Object.prototype.hasOwnProperty.call(state.quiz, slide.id)
    const chosen = state.quiz[slide.id]

    const buttons = q.options.map((text, k) => {
      const b = document.createElement('button')
      b.className = 'quiz-opt'
      b.type = 'button'
      b.innerHTML = text
      b.addEventListener('click', () => {
        if (Object.prototype.hasOwnProperty.call(state.quiz, slide.id)) return
        state.quiz[slide.id] = k
        save('quiz', state.quiz)
        settle(k)
      })
      box.appendChild(b)
      return b
    })

    function settle (pick) {
      buttons.forEach((b, k) => {
        b.disabled = true
        if (k === q.answer) {
          b.classList.add('correct')
          b.innerHTML += '<span class="mark">correct</span>'
        } else if (k === pick) {
          b.classList.add('wrong')
          b.innerHTML += '<span class="mark">chosen</span>'
        }
      })
      explain.hidden = false
    }

    box.appendChild(explain)
    el.quizSlot.appendChild(box)
    if (answered) settle(chosen)
  }

  function render () {
    const slide = SLIDES[state.index]
    if (!slide) return

    el.crumbChapter.textContent = slide.chapter
    el.crumbTitle.textContent = slide.title
    el.counter.textContent = `${state.index + 1} / ${SLIDES.length}`
    el.progress.style.width = ((state.index + 1) / SLIDES.length * 100) + '%'

    el.prose.innerHTML =
      `<p class="eyebrow">${PGB.escapeHtml(slide.chapter)}</p>` +
      `<h1>${slide.title}</h1>` +
      slide.body

    el.panels.innerHTML = ''
    for (const panel of slide.panels || []) {
      el.panels.appendChild(panel.kind === 'svg' ? renderSvgPanel(panel) : renderCodePanel(panel))
    }

    renderQuiz(slide)

    el.paneProse.scrollTop = 0
    el.paneCode.scrollTop = 0
    el.prev.disabled = state.index === 0
    el.next.disabled = state.index === SLIDES.length - 1

    state.visited.add(slide.id)
    save('visited', Array.from(state.visited))
    save('slide', slide.id)

    renderDots()
    if (!el.drawer.hidden) renderToc()
    if (global.location.hash.slice(1) !== slide.id) {
      global.history.replaceState(null, '', '#' + slide.id)
    }
  }

  function renderDots () {
    el.dots.innerHTML = ''
    SLIDES.forEach((slide, k) => {
      const dot = document.createElement('button')
      dot.className = 'dot' +
        (k === state.index ? ' current' : '') +
        (state.visited.has(slide.id) ? ' visited' : '')
      dot.title = `${k + 1}. ${slide.title}`
      dot.addEventListener('click', () => go(k))
      el.dots.appendChild(dot)
    })
  }

  function renderToc () {
    el.toc.innerHTML = ''
    let chapter = null
    SLIDES.forEach((slide, k) => {
      if (slide.chapter !== chapter) {
        chapter = slide.chapter
        const h = document.createElement('div')
        h.className = 'toc-chapter'
        h.textContent = chapter
        el.toc.appendChild(h)
      }
      const b = document.createElement('button')
      b.className = 'toc-item' + (k === state.index ? ' current' : '')
      b.innerHTML =
        `<span class="toc-num">${k + 1}</span>` +
        `<span>${PGB.escapeHtml(slide.title)}</span>` +
        (state.visited.has(slide.id) ? '<span class="toc-tick">&#10003;</span>' : '')
      b.addEventListener('click', () => { go(k); closeOverlays() })
      el.toc.appendChild(b)
    })
    const current = el.toc.querySelector('.current')
    if (current) current.scrollIntoView({ block: 'center' })
  }

  /* ---------- navigation ---------- */

  function go (index) {
    state.index = Math.max(0, Math.min(SLIDES.length - 1, index))
    render()
  }

  const next = () => go(state.index + 1)
  const prev = () => go(state.index - 1)

  function openDrawer () { el.drawer.hidden = false; renderToc() }
  function openHelp () { el.help.hidden = false }
  function closeOverlays () { el.drawer.hidden = true; el.help.hidden = true }

  el.next.addEventListener('click', next)
  el.prev.addEventListener('click', prev)
  $('btn-index').addEventListener('click', openDrawer)
  $('btn-help').addEventListener('click', openHelp)
  $('drawer-close').addEventListener('click', closeOverlays)
  $('help-close').addEventListener('click', closeOverlays)
  for (const node of document.querySelectorAll('[data-close]')) {
    node.addEventListener('click', closeOverlays)
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return
    const tag = (ev.target.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea') return

    switch (ev.key) {
      case 'ArrowRight': case 'l': case ' ': next(); ev.preventDefault(); break
      case 'ArrowLeft': case 'h': prev(); ev.preventDefault(); break
      case 'j': next(); break
      case 'k': prev(); break
      case 'g': el.drawer.hidden ? openDrawer() : closeOverlays(); break
      case '?': el.help.hidden ? openHelp() : closeOverlays(); break
      case 'Escape': closeOverlays(); break
    }
  })

  global.addEventListener('hashchange', () => {
    const k = SLIDES.findIndex((s) => s.id === global.location.hash.slice(1))
    if (k >= 0 && k !== state.index) go(k)
  })

  /* ---------- splitter ---------- */

  // Set as a custom property rather than an inline flex-basis so the narrow-screen media query,
  // which stacks the panes, can still override it.
  function applyRatio () {
    document.documentElement.style.setProperty('--split-ratio', state.ratio + '%')
  }

  el.gutter.addEventListener('pointerdown', (ev) => {
    ev.preventDefault()
    el.gutter.classList.add('dragging')
    document.body.classList.add('dragging')

    const move = (e) => {
      const box = el.split.getBoundingClientRect()
      const pct = (e.clientX - box.left) / box.width * 100
      state.ratio = Math.max(22, Math.min(72, pct))
      applyRatio()
    }
    const up = () => {
      el.gutter.classList.remove('dragging')
      document.body.classList.remove('dragging')
      save('split', state.ratio)
      global.removeEventListener('pointermove', move)
      global.removeEventListener('pointerup', up)
    }
    global.addEventListener('pointermove', move)
    global.addEventListener('pointerup', up)
  })

  /* ---------- boot ---------- */

  applyRatio()

  const fromHash = SLIDES.findIndex((s) => s.id === global.location.hash.slice(1))
  const fromStore = SLIDES.findIndex((s) => s.id === load('slide', null))
  state.index = fromHash >= 0 ? fromHash : (fromStore >= 0 ? fromStore : 0)

  render()
})(window)
