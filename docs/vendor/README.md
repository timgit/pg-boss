# Vendored docsify assets

These are pinned copies of docsify so the docs site loads no third-party JS/CSS from a CDN at
runtime. The one remaining external request is the Google Fonts `@import` at the top of `dark.css`,
which is intentionally kept.

Pinned version: **docsify 4.13.1**

Refresh (bump the version and re-download):

```sh
V=4.13.1
curl -sfS "https://cdn.jsdelivr.net/npm/docsify@${V}/lib/docsify.min.js"            -o docs/vendor/docsify.min.js
curl -sfS "https://cdn.jsdelivr.net/npm/docsify@${V}/lib/themes/dark.css"           -o docs/vendor/dark.css
curl -sfS "https://cdn.jsdelivr.net/npm/docsify@${V}/lib/plugins/search.min.js"     -o docs/vendor/plugins/search.min.js
```
