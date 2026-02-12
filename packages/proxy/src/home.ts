import { html, raw } from 'hono/html'

type HomeParams = {
  base: string
  methods: string[]
}

export const renderHome = ({ base, methods }: HomeParams) => {
  const methodList = raw(methods.map((method) => `<li><code>${base}/${method}</code></li>`).join(''))

  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pg-boss proxy</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3f0e7;
        --panel: #ffffff;
        --ink: #1a1a1a;
        --muted: #5f5f5f;
        --accent: #b63b2e;
        --accent-2: #0e5966;
      }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--ink);
        background: radial-gradient(circle at top left, #fdf7e9 0%, var(--bg) 55%, #efe6d1 100%);
      }
      main {
        max-width: 980px;
        margin: 0 auto;
        padding: 56px 24px 80px;
      }
      header {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 20px;
        margin-bottom: 32px;
      }
      h1 {
        font-family: "Space Grotesk", "Segoe UI", sans-serif;
        font-size: clamp(2.4rem, 3vw, 3.4rem);
        letter-spacing: -0.02em;
        margin: 0;
      }
      p {
        margin: 0;
        color: var(--muted);
        font-size: 1.05rem;
        line-height: 1.6;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
        margin: 32px 0 40px;
      }
      .card {
        background: var(--panel);
        border-radius: 16px;
        padding: 18px;
        border: 1px solid #e2d8c5;
        box-shadow: 0 10px 30px rgba(28, 26, 23, 0.08);
      }
      .card h3 {
        margin: 0 0 8px;
        font-family: "Space Grotesk", "Segoe UI", sans-serif;
        font-size: 1.1rem;
      }
      .card a {
        color: var(--accent-2);
        font-weight: 600;
        text-decoration: none;
      }
      .card a:hover {
        text-decoration: underline;
      }
      .panel {
        background: linear-gradient(135deg, rgba(182, 59, 46, 0.1), rgba(14, 89, 102, 0.08));
        border-radius: 20px;
        padding: 24px;
        border: 1px solid #eadfce;
      }
      code {
        background: rgba(26, 26, 26, 0.08);
        padding: 2px 6px;
        border-radius: 4px;
        font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
      }
      ul {
        padding-left: 18px;
        columns: 2;
        column-gap: 32px;
        margin: 12px 0 0;
      }
      li {
        margin-bottom: 6px;
      }
      pre {
        margin: 12px 0 0;
        background: rgba(255, 255, 255, 0.8);
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid #efe4d2;
        overflow-x: auto;
      }
      @media (max-width: 720px) {
        ul { columns: 1; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>pg-boss proxy</h1>
        <p>HTTP proxy for pg-boss methods, with a generated OpenAPI contract.</p>
      </header>

      <section class="cards">
        <div class="card">
          <h3>OpenAPI JSON</h3>
          <a href="/openapi.json">/openapi.json</a>
        </div>
        <div class="card">
          <h3>Interactive docs</h3>
          <a href="/docs">/docs</a>
        </div>
        <div class="card">
          <h3>Meta payload</h3>
          <a href="${base}/meta">${base}/meta</a>
        </div>
      </section>

      <section>
        <h2>Methods</h2>
        <ul>${methodList}</ul>
      </section>
    </main>
  </body>
</html>`
}
