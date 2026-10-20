// Copyright (c) 2026 UnieAI. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStub } from "../../scripts/unieai-ava-artifacts-stub.mjs";
import {
  ArtifactsClient,
  IdMemory,
  LIMITS,
  collectFromPath,
  findExternalRefs,
  mergeFiles,
  normalizeSitePath,
  resolveAccount,
  titleOf,
  validateSite,
} from "./unieai-artifacts-core.mjs";
import { DESCRIPTION, PARAMETERS, TOOL_NAME, apply, runArtifactAction } from "./unieai-artifacts.mjs";
import { BUNDLED_SKILLS_DIR, artifactsEnabled, renderPatch, selectPlugins } from "./config.mjs";

const KEY = "rk-secret-desktop-key-123";
const page = (body, title = "Test Page") => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const file = (path, text) => ({ path, bytes: Buffer.from(text) });

function fakeHome({ account = "rabi", url = "http://127.0.0.1:1" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "unieai-artifacts-home-"));
  writeFileSync(
    join(home, "unieai.json"),
    JSON.stringify({ account, studio_url: url, access_token: "", refresh_token: "", expires_at: 0, email: "u@example.com", gateway_base_url: `${url}/api/desktop/v1`, gateway_api_key: KEY }),
  );
  return home;
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "unieai-artifacts-ws-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

// --- validation ---------------------------------------------------------------

test("external references are found in HTML, CSS and ESM, each with what to inline", () => {
  const html = [
    "<!doctype html><html><head>",
    '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="canonical" href="https://example.com/page">',
    '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
    "<style>@import url('https://fonts.googleapis.com/css2?family=Inter'); body{background:url(//img.example.com/bg.png)}</style>",
    '<script type="module">import { x } from "https://esm.sh/lib"; const d = await fetch("https://api.example.com/data");</script>',
    "</head><body>",
    '<a href="https://example.com">a link is fine</a>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    '<img src="data:image/png;base64,AAAA"> <img src="./local.png"> <img srcset="a.png 1x, https://x.example/b.png 2x">',
    '<iframe src="https://youtube.com/embed/x"></iframe>',
    "<!-- <script src=\"https://commented.out/x.js\"></script> -->",
    "</body></html>",
  ].join("\n");
  const refs = findExternalRefs([file("index.html", html), file("app.js", 'import "https://unpkg.com/a.js";\nexport { y } from "//cdn.x/y.js";'), file("s.css", "a{background:url(https://x/y.png)}")]);
  const summary = refs.map((ref) => `${ref.file}:${ref.line} ${ref.what} ${ref.ref}`);
  assert.deepEqual(summary, [
    "index.html:7 import https://esm.sh/lib",
    "index.html:7 fetch() https://api.example.com/data",
    "index.html:6 @import https://fonts.googleapis.com/css2?family=Inter",
    "index.html:6 url() //img.example.com/bg.png",
    "index.html:2 <link> https://cdn.example.com/x.css",
    "index.html:3 <link> https://fonts.googleapis.com",
    "index.html:5 <script> https://cdn.jsdelivr.net/npm/chart.js",
    "index.html:11 <img> https://x.example/b.png",
    "index.html:12 <iframe> https://youtube.com/embed/x",
    "app.js:1 import https://unpkg.com/a.js",
    "app.js:2 export from //cdn.x/y.js",
    "s.css:1 url() https://x/y.png",
  ]);
  const byRef = Object.fromEntries(refs.map((ref) => [ref.ref, ref.fix]));
  assert.match(byRef["https://cdn.jsdelivr.net/npm/chart.js"], /inline <script>.*inline <svg>/);
  assert.match(byRef["https://cdn.example.com/x.css"], /<style> block/);
  assert.match(byRef["https://fonts.googleapis.com/css2?family=Inter"], /system-ui/);
  assert.match(byRef["https://api.example.com/data"], /connect-src 'none'/);
  assert.match(byRef["https://esm.sh/lib"], /import it relatively/);
  assert.match(byRef["https://x/y.png"], /data: URI/);
});

test("validateSite reports every limit, then external refs, as one actionable error", () => {
  assert.doesNotThrow(() => validateSite([file("index.html", page("ok"))]));
  assert.throws(() => validateSite([file("page.html", page("x"))]), { code: "too_large", message: /no index\.html/ });
  const big = { path: "index.html", bytes: Buffer.alloc(LIMITS.maxFileBytes + 1) };
  assert.throws(() => validateSite([big]), { code: "too_large", message: /4\.0 MiB per file/ });
  const many = [file("index.html", page("x")), ...Array.from({ length: 49 }, (_, i) => file(`a${i}.txt`, "x"))];
  assert.throws(() => validateSite(many), { message: /49 files besides index\.html; the limit is 48/ });
  const deps = [file("index.html", page("x")), ...Array.from({ length: 4 }, (_, i) => ({ path: `d${i}.bin`, bytes: Buffer.alloc(3.5 * 1024 * 1024) }))];
  assert.throws(() => validateSite(deps), { message: /total 14\.0 MiB; the limit is 12\.0 MiB/ });
  assert.throws(
    () => validateSite([file("index.html", page('<script src="https://cdn.x/lib.js"></script>'))]),
    (error) => error.code === "external_ref" && /index\.html:1 <script> https:\/\/cdn\.x\/lib\.js -> paste the library's code/.test(error.message),
  );
});

test("paths, titles and merges", () => {
  assert.equal(normalizeSitePath("./assets/a.png"), "assets/a.png");
  for (const bad of ["../x", "/etc/passwd", "a//b", "C:/x", ""]) assert.throws(() => normalizeSitePath(bad), { code: "bad_path" });
  assert.equal(titleOf([file("index.html", page("x", "  Q3   Report "))]), "Q3 Report");
  const merged = mergeFiles(
    [{ path: "index.html", contentBase64: Buffer.from("old").toString("base64") }, { path: "notes.txt", contentBase64: Buffer.from("theirs").toString("base64") }],
    [file("index.html", "new")],
  );
  assert.deepEqual(merged.map((f) => [f.path, f.bytes.toString()]), [["index.html", "new"], ["notes.txt", "theirs"]]);
});

test("a directory uploads whole without dot-files; a single .html file becomes index.html", () => {
  const dir = mkdtempSync(join(tmpdir(), "unieai-site-"));
  writeFileSync(join(dir, "index.html"), page("x"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "logo.svg"), "<svg/>");
  writeFileSync(join(dir, ".DS_Store"), "x");
  assert.deepEqual(collectFromPath(dir).map((f) => f.path), ["assets/logo.svg", "index.html"]);
  writeFileSync(join(dir, "report.html"), page("r"));
  assert.deepEqual(collectFromPath(join(dir, "report.html")).map((f) => f.path), ["index.html"]);
  assert.throws(() => collectFromPath(join(dir, "assets")), { code: "no_entry" });
  assert.throws(() => collectFromPath(join(dir, "assets", "logo.svg")), { code: "not_html" });
});

// --- account ------------------------------------------------------------------

test("only a Rabi login can publish; a Studio user is told to link Rabi", () => {
  assert.throws(() => resolveAccount(fakeHome({ account: "studio" })), { code: "not_rabi", message: /unieai login --rabi/ });
  assert.throws(() => resolveAccount(mkdtempSync(join(tmpdir(), "empty-"))), { code: "not_signed_in" });
  const account = resolveAccount(fakeHome({ url: "https://agent.example.com/" }));
  assert.equal(account.baseUrl, "https://agent.example.com");
  assert.equal(account.apiKey, KEY);
});

// --- request shapes -----------------------------------------------------------

test("requests: routes, bearer key, body shape; the key never appears in errors", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/art_9") && init.method === "PUT") {
      return new Response(JSON.stringify({ error: { code: "quota_exceeded", message: `no room for ${KEY}` } }), { status: 429 });
    }
    if (url.includes("?mine=1")) return Response.json({ artifacts: [{ id: "art_1", title: "T", url: "/share/html/tok", version: 2 }] });
    return Response.json({ id: "art_1", viewerUrl: "/share/html/tok", version: 1 });
  };
  const client = new ArtifactsClient({ baseUrl: "https://agent.example.com/", apiKey: KEY, fetchImpl });
  assert.equal(JSON.stringify(client).includes(KEY), false);
  await client.create({ title: "T", entry: "index.html", files: [], visibility: "private" });
  await client.update("art_1", { title: "T" }, 3);
  assert.deepEqual(await client.list(), [{ id: "art_1", title: "T", url: "/share/html/tok", version: 2 }]);
  await client.get("art_1");
  await client.remove("art_1");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      "POST https://agent.example.com/api/agent-next/artifacts/site",
      "PUT https://agent.example.com/api/agent-next/artifacts/art_1",
      "GET https://agent.example.com/api/agent-next/artifacts?mine=1&source=unieai-code",
      "GET https://agent.example.com/api/agent-next/artifacts/art_1",
      "DELETE https://agent.example.com/api/agent-next/artifacts/art_1",
    ],
  );
  assert.ok(calls.every((c) => c.auth === `Bearer ${KEY}`));
  assert.equal(calls[1].body.expectedVersion, 3);
  assert.equal(client.absolute("/share/html/tok"), "https://agent.example.com/share/html/tok");
  const error = await client.update("art_9", {}, 1).catch((e) => e);
  assert.equal(error.code, "quota_exceeded");
  assert.match(error.message, /quota is full/);
  assert.equal(error.message.includes(KEY), false);
  const unauthorized = new ArtifactsClient({ baseUrl: "https://a", apiKey: KEY, fetchImpl: async () => new Response("", { status: 403 }) });
  await assert.rejects(unauthorized.list(), { code: "unauthorized", message: /`artifacts` scope.*unieai login --rabi/ });
});

test("publish body: entry, base64 files with mime, visibility, header; public is refused", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ id: "art_1", viewerUrl: "/share/html/tok", version: 1 });
  };
  const home = fakeHome({ url: "https://agent.example.com" });
  const ws = workspace();
  const out = await runArtifactAction(
    {
      action: "publish",
      files: [{ path: "index.html", content: page("hi", "Hello Page") }, { path: "a.png", content_base64: "iVBORw==" }],
      description: "one line",
      visibility: "org",
      header: { icon: "chart", show_author: false, title: " " },
    },
    { home, cwd: ws, fetchImpl },
  );
  assert.deepEqual(bodies[0], {
    title: "Hello Page",
    entry: "index.html",
    files: [
      { path: "index.html", mime: "text/html", contentBase64: Buffer.from(page("hi", "Hello Page")).toString("base64") },
      { path: "a.png", mime: "image/png", contentBase64: "iVBORw==" },
    ],
    visibility: "org",
    description: "one line",
    header: { icon: "chart", showAuthor: false },
  });
  assert.match(out, /^Published a new page: "Hello Page"\nhttps:\/\/agent\.example\.com\/share\/html\/tok\nid art_1 · version 1 · org · 2 files/);
  await assert.rejects(runArtifactAction({ action: "publish", files: [{ path: "index.html", content: "x" }], visibility: "public" }, { home, cwd: ws, fetchImpl }), /web UI/);
});

// --- against the stub: memory, updates, 409 ---------------------------------

test("publishing the same path again updates in place; the id memory is per workspace and account", async () => {
  const stub = await startStub({ apiKey: KEY });
  try {
    const home = fakeHome({ url: stub.url });
    const ws = workspace();
    mkdirSync(join(ws, "pages"));
    writeFileSync(join(ws, "pages", "report.html"), page("v1", "Weekly Report"));
    const first = await runArtifactAction({ action: "publish", path: "pages/report.html" }, { home, cwd: ws });
    assert.match(first, /Published a new page: "Weekly Report"/);
    const memory = JSON.parse(readFileSync(join(home, "artifacts.json"), "utf8"));
    assert.deepEqual(Object.keys(memory.workspaces), [ws]);
    assert.equal(memory.workspaces[ws]["pages/report.html"].id, "art_1");
    assert.equal(memory.workspaces[ws]["pages/report.html"].version, 1);
    assert.equal(readFileSync(join(home, "artifacts.json"), "utf8").includes(KEY), false);

    writeFileSync(join(ws, "pages", "report.html"), page("v2", "Weekly Report"));
    // From a subdirectory of the same workspace: same page.
    const second = await runArtifactAction({ action: "publish", path: "report.html" }, { home, cwd: join(ws, "pages") });
    assert.match(second, /Updated the page in place: "Weekly Report"[\s\S]*id art_1 · version 2/);
    assert.equal(stub.store.size, 1);
    assert.deepEqual(stub.requests.filter((r) => r.path.includes("/artifacts")).map((r) => `${r.method} ${r.body?.expectedVersion ?? ""}`), ["POST ", "PUT 1"]);

    // Another workspace with the same relative path is a different page.
    const other = workspace();
    mkdirSync(join(other, "pages"));
    writeFileSync(join(other, "pages", "report.html"), page("other", "Other Report"));
    assert.match(await runArtifactAction({ action: "publish", path: "pages/report.html" }, { home, cwd: other }), /new page[\s\S]*id art_2/);

    const listed = await runArtifactAction({ action: "list" }, { home, cwd: ws });
    assert.match(listed, /2 artifacts:/);
    assert.match(listed, new RegExp(`"Weekly Report" ${stub.url}/share/html/[\\w-]+\\n {3}id art_1 · version 2 · updated [^\\n]+\\n {3}from ${join(ws, "pages", "report.html")}`));

    // A page deleted in ava: the next publish of its path makes a new one.
    await runArtifactAction({ action: "delete", id: "art_2" }, { home, cwd: other });
    assert.equal(new IdMemory(home).pathsOf("art_2").length, 0);
    stub.store.get("art_1").deleted = true;
    assert.match(await runArtifactAction({ action: "publish", path: "pages/report.html" }, { home, cwd: ws }), /new page[\s\S]*id art_3/);
  } finally {
    await stub.close();
  }
});

test("a 409 returns the current version; merge: true lays our files over it and retries once", async () => {
  const stub = await startStub({ apiKey: KEY });
  try {
    const home = fakeHome({ url: stub.url });
    const ws = workspace();
    const site = join(ws, "site");
    mkdirSync(site);
    writeFileSync(join(site, "index.html"), page("v1", "Team Dashboard"));
    await runArtifactAction({ action: "publish", path: "site" }, { home, cwd: ws });
    await stub.bump("art_1"); // edited in the web UI: now version 2 with notes.txt

    writeFileSync(join(site, "index.html"), page("mine", "Team Dashboard"));
    const conflict = await runArtifactAction({ action: "publish", path: "site" }, { home, cwd: ws }).catch((e) => e);
    assert.equal(conflict.code, "version_conflict");
    assert.equal(conflict.currentVersion, 2);
    assert.match(conflict.message, /is at version 2, but this update was based on version 1[\s\S]*expected_version 2[\s\S]*merge: true/);

    const merged = await runArtifactAction({ action: "publish", path: "site", merge: true }, { home, cwd: ws });
    assert.match(merged, /Merged with the current version and updated the page in place[\s\S]*version 3/);
    const row = stub.store.get("art_1");
    assert.deepEqual(row.files.map((f) => f.path).sort(), ["index.html", "notes.txt"]);
    assert.match(Buffer.from(row.files.find((f) => f.path === "index.html").contentBase64, "base64").toString(), /mine/);
    assert.equal(new IdMemory(home).lookup(ws, site, resolveAccount(home).account).version, 3);

    // read with save_to: the files land on disk and that directory now publishes to the same page.
    await stub.bump("art_1");
    const readOut = await runArtifactAction({ action: "read", id: "art_1", save_to: "pulled" }, { home, cwd: ws });
    assert.match(readOut, /"Team Dashboard"[\s\S]*version 4[\s\S]*Saved 2 files to[\s\S]*--- notes\.txt \(text\/plain\)\nedited in the web UI \(v4\)/);
    assert.ok(existsSync(join(ws, "pulled", "notes.txt")));
    writeFileSync(join(ws, "pulled", "index.html"), page("merged by hand", "Team Dashboard"));
    assert.match(await runArtifactAction({ action: "publish", path: "pulled" }, { home, cwd: ws }), /Updated the page in place[\s\S]*id art_1 · version 5/);
  } finally {
    await stub.close();
  }
});

test("the stub's own preflight errors come back with ava's codes", async () => {
  const stub = await startStub({ apiKey: KEY });
  try {
    const home = fakeHome({ url: stub.url });
    const client = new ArtifactsClient({ baseUrl: stub.url, apiKey: KEY });
    const error = await client
      .create({ title: "x", entry: "index.html", visibility: "private", files: [{ path: "index.html", contentBase64: Buffer.from('<img src="https://x/y.png">').toString("base64") }] })
      .catch((e) => e);
    assert.equal(error.code, "external_ref");
    assert.match(error.message, /inline it/);
    const wrongKey = new ArtifactsClient({ baseUrl: stub.url, apiKey: "other" });
    await assert.rejects(wrongKey.list(), { code: "unauthorized" });
    assert.ok(home);
  } finally {
    await stub.close();
  }
});

// --- the dsh plugin and the patch ---------------------------------------------

test("the plugin registers publish_artifact; errors reach the model as plain messages", async () => {
  let tool;
  apply({ tools: { register: (definition) => (tool = definition) }, get: () => undefined }, { home: fakeHome({ account: "studio" }) });
  assert.equal(tool.name, TOOL_NAME);
  assert.match(DESCRIPTION, /Only delete when the user asks/);
  assert.deepEqual(PARAMETERS.action.enum, ["publish", "list", "read", "delete"]);
  await assert.rejects(tool.execute({ action: "list" }, undefined), (error) => error.constructor === Error && /signed in to UnieAI Studio[\s\S]*unieai login --rabi/.test(error.message));
});

test("the uac patch loads unieai-artifacts and the bundled skills dir; minimal mode and UNIEAI_DSH_PLUGINS leave them out", () => {
  const plugins = selectPlugins({ UNIEAI_DSH_PLUGINS: "unieai-skills" });
  const patch = renderPatch({ defaultModel: "A", plugins, artifacts: true, home: "/h" });
  assert.match(patch, / {4}- id: unieai-artifacts\n {6}name: "file:[^"]+unieai-artifacts\.mjs"\n {6}config:\n {8}home: "\/h"/);
  assert.match(patch, new RegExp(`- id: unieai-skills\\n {6}name: "[^"]+"\\n {6}config:\\n {8}home: "/h"\\n {8}bundledSkillDir: ${JSON.stringify(BUNDLED_SKILLS_DIR).replace(/[/\\]/g, "\\$&")}`));
  assert.doesNotMatch(renderPatch({ defaultModel: "A", plugins, artifacts: true, mode: "minimal" }), /unieai-artifacts|bundledSkillDir/);
  assert.doesNotMatch(renderPatch({ defaultModel: "A", plugins }), /unieai-artifacts/);
  assert.ok(existsSync(join(BUNDLED_SKILLS_DIR, "artifact", "SKILL.md")));
  assert.equal(artifactsEnabled({}), true);
  assert.equal(artifactsEnabled({ UNIEAI_DSH_PLUGINS: "off" }), false);
  assert.equal(artifactsEnabled({ UNIEAI_DSH_PLUGINS: "unieai-exec,unieai-artifacts" }), true);
});

test("the bundled artifact skill parses and covers the rules", () => {
  const text = readFileSync(join(BUNDLED_SKILLS_DIR, "artifact", "SKILL.md"), "utf8");
  assert.match(text, /^---\nname: artifact\ndescription: "[^"]+"\n/);
  for (const rule of [/link once/, /2–4 words/, /prefers-color-scheme: dark/, /16px side gutter/, /inline SVG/, /updates the page in place/, /`header` fields/]) assert.match(text, rule);
  assert.deepEqual(findExternalRefs([file("index.html", text.match(/```html\n([\s\S]*?)```/)[1])]), [], "the template is inline-only");
});
