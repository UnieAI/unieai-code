---
name: artifact
description: "Write and publish a web page (report, dashboard, diagram, small tool) to the user's UnieAI gallery with publish_artifact. Load before writing any page you will publish."
whenToUse: "The user wants a page to read, share or use: a report, summary, dashboard, chart, diagram, explainer or small interactive tool. Not for code or docs that belong in the repository."
---
<!-- Copyright (c) 2026 UnieAI. All rights reserved. -->
# Publishing a page

## When
- Publish when the result is a page for people to read or use: a report, a dashboard, a diagram, a small tool. Code, configs and docs that belong in the repository go in the repository, not in a page.
- Publish once the page is done, then give the link once in your answer. Do not paste the HTML into the chat.
- Delete a page only when the user asks for that page to be deleted.

## The file
- One self-contained `index.html`, saved where the user asks, else at `.unieai/pages/<name>/index.html`.
- Inline everything: CSS in `<style>`, JS in `<script>`, images as inline `<svg>` or `data:` URIs, data as a JSON literal. No `http(s)://` scripts, stylesheets, fonts, images, `import`s or `fetch`: the viewer loads nothing from the network and the publish is refused. The one exception: when a library is genuinely needed and too big to inline, `cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com` and Google Fonts are accepted. Inline first.
- System fonts: `font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
- `<title>` is a name of 2–4 words ("Q3 Latency Report"), not a sentence.
- Colours as tokens on `:root`, overridden under `@media (prefers-color-scheme: dark)`; `body` gets an explicit `background` and `color` from the tokens.
- Works at phone width: `<meta name="viewport" content="width=device-width, initial-scale=1">`, a 16px side gutter, `max-width` on the content, nothing wider than the screen (tables and code scroll inside their own box with `overflow-x: auto`), so the page never scrolls sideways.
- Size budget: aim under 300 KB; the hard limits are 4 MiB per file and 16 MiB per page. Draw charts by hand as inline SVG (a `<rect>` per bar, a `<polyline>` per series, text labels, coloured through CSS classes that use the tokens) instead of bundling a chart library.
- The viewer shows its own header bar (title, one-line description, icon, author). Set it with the tool's `header` fields (`title`, `description`, `icon`, `show_author`, which is off by default); never draw a header, logo bar or "made with" mark in the page.

## Publishing and updating
- `publish_artifact {action: "publish", path: ".unieai/pages/q3/index.html", title: "Q3 Latency Report", description: "p50/p99 by region, July–September", header: {icon: "chart"}}`
- To change a page, edit the same file and publish the same path again: it updates the page in place and keeps the link. Never publish a new page for an edit. For a page from another session, `list` to find its id and publish with that `id`.
- A version conflict means the page changed elsewhere: `read` it with `save_to`, merge your change into those files, and publish that directory; or publish again with `merge: true` to lay your files over the current ones.
- Pages are private. Share with the user's organization only when asked: `visibility: "org"` (if they belong to several organizations the tool says so; ask which and pass `org_id`). Making a page public is the user's step in the web UI.
- To change only who can see a page or its header, use `update_settings` with the `id` (no new version); `clear_header: true` removes the header.
- A refusal lists each external reference and how to inline it; fix them all and publish again.

## Template
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Build Health Summary</title>
<style>
  :root { --bg: #ffffff; --fg: #1d1f23; --muted: #5f6672; --card: #f4f5f7; --accent: #2563eb; --border: #e3e5e8; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #15171a; --fg: #e8eaed; --muted: #9aa0a8; --card: #1f2226; --accent: #6ea8fe; --border: #2e3237; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin: 16px 0; }
  .scroll { overflow-x: auto; }
  svg { max-width: 100%; height: auto; display: block; }
  .muted { color: var(--muted); }
  .bar { fill: var(--accent); }
  .label { fill: var(--muted); font-size: 9px; }
</style>
</head>
<body>
<main>
  <h1>Build Health Summary</h1>
  <p class="muted">Last 7 days of CI on main.</p>
  <section class="card">
    <svg viewBox="0 0 320 120" role="img" aria-label="Passing builds per day">
      <rect class="bar" x="10" y="40" width="30" height="70"/>
      <rect class="bar" x="55" y="20" width="30" height="90"/>
      <text class="label" x="25" y="118" text-anchor="middle">Mon</text>
      <text class="label" x="70" y="118" text-anchor="middle">Tue</text>
    </svg>
  </section>
</main>
</body>
</html>
```
