# pg-boss codebase tutorial

A guided tour of `src/`, in 36 slides across 9 chapters. Prose on the left, the real source on the
right — every code panel labelled `src/file.ts:120-155` is copied verbatim from that file.

## Open it

```
open tutorial/index.html
```

No build step, no server, no dependencies. It is deliberately plain `<script>` tags rather than ES
modules, because Chrome blocks module loads over `file://` and the whole point is that opening the
file works.

Keyboard: `←`/`→` or `j`/`k` to move, `g` for the slide index, `?` for help, `Esc` to close.
Progress, visited slides and quiz answers are stored in `localStorage`. The URL hash is the slide
id, so any slide is linkable.

## Verify it still matches the code

```
bun tutorial/verify-excerpts.mjs
```

Reads every code panel that names a `file`, checks the excerpt appears in that file verbatim, and
reports the real line numbers when a declared range has drifted. Also checks slide structure —
unique ids, quiz answers in range, every diagram reference resolving.

Run it after changing anything in `src/` that the tutorial quotes. It is standalone and is **not**
wired into `package.json`, so it can never affect `bun run test`.

## Layout

| File | What it holds |
| --- | --- |
| `index.html` | The page shell — panes, nav, drawer, overlays |
| `styles.css` | Layout and theming (light/dark via `prefers-color-scheme`) |
| `highlight.js` | Hand-rolled TS/SQL/JSON tokenizer, `window.PGB.highlightLines` |
| `diagrams.js` | Ten inline SVG diagrams, `window.PGB.DIAGRAMS` |
| `slides.js` | The curriculum, `window.PGB.SLIDES` |
| `app.js` | Rendering, routing, keyboard, quiz and progress state |
| `verify-excerpts.mjs` | The excerpt and structure checker |

## Adding or editing a slide

Slides are one flat array in `slides.js`; chapters are derived from the `chapter` field, so there
is no second structure to update.

```js
{
  id: 'stable-slug',            // used as the URL hash — do not change casually
  chapter: 'Consuming jobs',
  title: 'fetch(): claiming a job',
  body: `<p>…</p>`,             // HTML, rendered in the left pane
  panels: [
    { kind: 'code', lang: 'sql', file: 'src/plans.ts', lines: '1443-1451', text: `…` },
    { kind: 'code', lang: 'ts', label: 'illustrative', text: `…` },   // no file = not verified
    { kind: 'svg', name: 'fetch-race', caption: '…' }
  ],
  quiz: { q: '…', options: ['…', '…'], answer: 1, explain: '…' }      // optional
}
```

Two things to watch when pasting source into a `text` template literal: escape backticks as
`` \` `` and `${` as `\${`. The verifier catches a mistake either way — either the file fails to
parse, or the excerpt no longer matches.

`lang` is `ts`, `sql`, `json`, or anything else for plain text. `lines` drives the gutter line
numbers as well as the drift check.
