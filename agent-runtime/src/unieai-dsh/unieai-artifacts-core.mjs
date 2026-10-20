// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-artifacts-core.mjs — publish pages to ava (agent.unieai.com) as
 * artifacts: local validation, the HTTP routes, and the id memory.
 *
 * See docs/unieai/artifacts-spec.md. ava hosts the pages under
 * `/api/agent-next/artifacts`, authenticated with the Rabi desktop key that
 * `unieai login --rabi` stores in `$UNIEAI_HOME/unieai.json`
 * (`account: "rabi"`, `studio_url` = the Rabi origin, `gateway_api_key` = the
 * key). v1 is inline-only: ava's preflight rejects external http(s)
 * references, so they are found here first, with what to inline instead.
 *
 * The id memory (`$UNIEAI_HOME/artifacts.json`) maps a workspace and a source
 * path to the artifact it was published as, so publishing the same file again
 * updates that page instead of making a new one. It lives in the UnieAI home,
 * not the project's `.unieai/`: an artifact id belongs to the signed-in
 * account (pages are private by default), while `.unieai/` is checked into
 * repositories, where the ids would leak into git and point a teammate at
 * pages their key cannot update.
 *
 * The key is only ever sent as the Authorization header; no message, error
 * or log line here contains it.
 *
 * Shared by the uac `publish_artifact` tool (unieai-artifacts.mjs) and its
 * tests. The Rust CLI (`unieai artifact`) speaks the same routes and reads the
 * same id memory.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ROUTE = "/api/agent-next/artifacts";
export const SOURCE = "unieai-code";
export const ENTRY = "index.html";
export const MEMORY_FILE = "artifacts.json";

const MiB = 1024 * 1024;
/** ava's html-share limits (lib/agent-next/html-share-policy.ts). */
export const LIMITS = Object.freeze({
  maxFileBytes: 4 * MiB,
  maxDepsBytes: 12 * MiB,
  maxDeps: 48,
  maxShareBytes: 16 * MiB,
});

/** Directory entries never uploaded from a site directory. */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

export const MIME_TYPES = Object.freeze({
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
});

export function mimeOf(path) {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

const isText = (mime) => /^text\/|json|javascript|svg|xml/.test(mime);

/** An error the tool and the CLI show as is. `code` follows ava's codes where one applies. */
export class ArtifactsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ArtifactsError";
    this.code = code;
    Object.assign(this, extra);
  }
}

export function unieaiHome(env = process.env) {
  return resolve(env.UNIEAI_HOME || env.CODEX_HOME || join(homedir(), ".unieai"));
}

/**
 * The ava account to publish with: the stored Rabi login. A Studio login has
 * no key ava accepts (single sign-on is a later phase), so it gets told how
 * to link Rabi instead.
 * @returns {{baseUrl: string, apiKey: string, account: string}}
 */
export function resolveAccount(home = unieaiHome()) {
  let stored;
  try {
    stored = JSON.parse(readFileSync(join(home, "unieai.json"), "utf8"));
  } catch {
    throw new ArtifactsError("not_signed_in", "Publishing artifacts needs a UnieAI Rabi sign-in (agent.unieai.com). Run `unieai login --rabi`, then publish again.");
  }
  if (stored?.account !== "rabi") {
    throw new ArtifactsError(
      "not_rabi",
      "Artifacts are hosted by UnieAI Rabi (agent.unieai.com), and this machine is signed in to UnieAI Studio, whose key Rabi does not accept. " +
        "Link a Rabi account with `unieai login --rabi` (it replaces the Studio sign-in here; Studio single sign-on is planned). " +
        "Until then, the page stays a local file.",
    );
  }
  const baseUrl = String(stored.studio_url ?? "").trim().replace(/\/+$/, "");
  const apiKey = String(stored.gateway_api_key ?? "");
  if (!baseUrl || !apiKey) {
    throw new ArtifactsError("not_signed_in", "The stored Rabi sign-in is incomplete. Run `unieai login --rabi` again.");
  }
  return { baseUrl, apiKey, account: `${baseUrl}|${stored.email ?? ""}` };
}

// --- collecting the files -------------------------------------------------

const fmtBytes = (n) => (n >= MiB ? `${(n / MiB).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

/** A site path as uploaded: relative, forward slashes, no `..`. */
export function normalizeSitePath(path) {
  const value = String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value || value.startsWith("/") || /^[a-zA-Z]:/.test(value) || value.split("/").some((part) => part === ".." || part === "")) {
    throw new ArtifactsError("bad_path", `"${path}" is not a usable site path: use a relative path like "index.html" or "assets/logo.svg".`);
  }
  return value;
}

/**
 * The files to upload from a local path: an HTML file becomes the site's
 * index.html; a directory must have index.html at its top and is uploaded
 * whole (dot-files and node_modules skipped).
 * @returns {{path: string, bytes: Buffer}[]}
 */
export function collectFromPath(absPath) {
  let info;
  try {
    info = statSync(absPath);
  } catch {
    throw new ArtifactsError("not_found", `${absPath} does not exist.`);
  }
  if (info.isFile()) {
    if (!/\.html?$/i.test(absPath)) {
      throw new ArtifactsError("not_html", `${basename(absPath)} is not an HTML page. Publish an .html file (it becomes index.html) or a directory with index.html at its top.`);
    }
    return [{ path: ENTRY, bytes: readFileSync(absPath) }];
  }
  if (!info.isDirectory()) throw new ArtifactsError("not_html", `${absPath} is neither a file nor a directory.`);
  if (!existsSync(join(absPath, ENTRY))) {
    throw new ArtifactsError("no_entry", `${absPath} has no index.html at its top; the page's entry must be index.html.`);
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        // Stop reading early: past this many the upload is refused anyway.
        if (files.length > LIMITS.maxDeps + 1) {
          throw new ArtifactsError("too_large", `${absPath} has more than ${LIMITS.maxDeps} files besides index.html (ava's limit). Publish a folder with only the page and the files it uses, or inline small assets into index.html.`);
        }
        files.push({ path: relative(absPath, full).split(sep).join("/"), bytes: readFileSync(full) });
      }
    }
  };
  walk(absPath);
  return files;
}

/** Inline files from the tool call: `{path, content}` (UTF-8) or `{path, content_base64}`. */
export function collectInline(files) {
  if (!Array.isArray(files) || files.length === 0) throw new ArtifactsError("bad_request", "files must be a non-empty list of {path, content} (or content_base64).");
  return files.map((file) => {
    const path = normalizeSitePath(file?.path);
    if (typeof file?.content === "string") return { path, bytes: Buffer.from(file.content, "utf8") };
    if (typeof file?.content_base64 === "string") return { path, bytes: Buffer.from(file.content_base64, "base64") };
    throw new ArtifactsError("bad_request", `files entry "${path}" needs content (text) or content_base64.`);
  });
}

// --- validation -------------------------------------------------------------

const EXTERNAL = /^\s*(?:https?:)?\/\//i;
const lineAt = (text, index) => text.slice(0, index).split("\n").length;
const clip = (value, max = 90) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const FIX = {
  script: "paste the library's code into an inline <script>…</script> (for a chart library, draw the chart as inline <svg> instead)",
  stylesheet: "copy the CSS into a <style> block",
  font: 'drop the web font and use a system stack: font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  image: "embed it as a data: URI (data:image/png;base64,…) or inline <svg>, or add the file to the upload and use a relative path",
  embed: "external embeds cannot load in the viewer; link to it with <a href> instead",
  cssImport: "copy the imported CSS into this stylesheet",
  module: 'inline the module\'s code, or add it to the upload as a file and import it relatively ("./lib.js")',
  network: "the page cannot make network requests (connect-src 'none'); embed the data in the page, e.g. <script type=\"application/json\" id=\"data\">…</script>",
  base: "remove the <base> tag; use relative paths",
  remove: "remove it (preloads and prefetches of external URLs cannot load)",
};

const IMAGE_TAGS = new Set(["img", "source", "video", "audio", "track", "image", "use", "input", "picture"]);
const EMBED_TAGS = new Set(["iframe", "embed", "object", "frame", "portal"]);
/** <link rel> values that only describe the page, never load anything. */
const INERT_RELS = new Set(["canonical", "alternate", "author", "license", "me", "help", "search", "bookmark", "external", "nofollow", "noopener", "noreferrer"]);
const isFontHost = (ref) => /fonts\.(googleapis|gstatic)\.com|use\.typekit\.net|fonts\.bunny\.net/i.test(ref);

function attrValue(attrs, name) {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function scanCss(file, text, offset, source, out) {
  for (const match of text.matchAll(/@import\s+(?:url\(\s*)?["']?((?:https?:)?\/\/[^"')\s;]+)/gi)) {
    out.push({ file, line: lineAt(source, offset + match.index), ref: match[1], what: "@import", fix: isFontHost(match[1]) ? FIX.font : FIX.cssImport });
  }
  for (const match of text.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi)) {
    // @import url(...) was reported above.
    if (/@import\s+$/i.test(text.slice(Math.max(0, match.index - 12), match.index))) continue;
    out.push({ file, line: lineAt(source, offset + match.index), ref: match[1], what: "url()", fix: isFontHost(match[1]) ? FIX.font : FIX.image });
  }
}

function scanJs(file, text, offset, source, out) {
  const patterns = [
    [/\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?["'`]((?:https?:)?\/\/[^"'`]+)["'`]/g, "import", FIX.module],
    [/\bimport\(\s*["'`]((?:https?:)?\/\/[^"'`]+)["'`]/g, "import()", FIX.module],
    [/\bexport\s+[\w*{}\s,$]+\s+from\s*["'`]((?:https?:)?\/\/[^"'`]+)["'`]/g, "export from", FIX.module],
    [/\bimportScripts\(\s*["'`]((?:https?:)?\/\/[^"'`]+)["'`]/g, "importScripts()", FIX.module],
    [/\bfetch\(\s*["'`]((?:https?:)?\/\/[^"'`]+)["'`]/g, "fetch()", FIX.network],
    [/\bnew\s+(?:WebSocket|EventSource)\(\s*["'`]((?:wss?:|https?:)?\/\/[^"'`]+)["'`]/g, "connection", FIX.network],
    [/\.open\(\s*["'](?:GET|POST|PUT|DELETE|PATCH)["']\s*,\s*["'`]((?:https?:)?\/\/[^"'`]+)["'`]/gi, "XMLHttpRequest", FIX.network],
  ];
  for (const [pattern, what, fix] of patterns) {
    for (const match of text.matchAll(pattern)) out.push({ file, line: lineAt(source, offset + match.index), ref: match[1], what, fix });
  }
}

function scanHtml(file, text, out) {
  // Script and style bodies are scanned as JS/CSS and blanked for the tag scan,
  // so a "<" inside code is not taken for a tag.
  let markup = text;
  for (const match of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi)) {
    const start = match.index + match[1].length;
    const type = attrValue(match[1], "type");
    if (!type || /module|javascript|ecmascript/i.test(type)) scanJs(file, match[2], start, text, out);
    markup = markup.slice(0, start) + " ".repeat(match[2].length) + markup.slice(start + match[2].length);
  }
  for (const match of text.matchAll(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi)) {
    const start = match.index + match[1].length;
    scanCss(file, match[2], start, text, out);
    markup = markup.slice(0, start) + " ".repeat(match[2].length) + markup.slice(start + match[2].length);
  }
  markup = markup.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
  for (const match of markup.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const line = lineAt(text, match.index);
    const style = attrValue(attrs, "style");
    if (style) scanCss(file, style, match.index, text, out);
    if (tag === "a" || tag === "area" || tag === "form") continue;
    const report = (ref, fix) => out.push({ file, line, ref, what: `<${tag}>`, fix });
    if (tag === "base") {
      const href = attrValue(attrs, "href");
      if (href && EXTERNAL.test(href)) report(href, FIX.base);
      continue;
    }
    if (tag === "link") {
      const href = attrValue(attrs, "href");
      if (!href || !EXTERNAL.test(href)) continue;
      const rels = String(attrValue(attrs, "rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (rels.length > 0 && rels.every((rel) => INERT_RELS.has(rel))) continue;
      if (isFontHost(href)) report(href, FIX.font);
      else if (rels.includes("stylesheet")) report(href, FIX.stylesheet);
      else if (rels.includes("modulepreload")) report(href, FIX.module);
      else if (rels.some((rel) => rel.includes("icon"))) report(href, FIX.image);
      else report(href, FIX.remove);
      continue;
    }
    for (const name of ["src", "href", "xlink:href", "poster", "data", "background", "srcset"]) {
      const value = attrValue(attrs, name.replace(":", "\\:"));
      if (!value) continue;
      const refs = name === "srcset" ? value.split(",").map((part) => part.trim().split(/\s+/)[0]) : [value];
      for (const ref of refs) {
        if (!EXTERNAL.test(ref)) continue;
        if (tag === "script") report(ref, FIX.script);
        else if (EMBED_TAGS.has(tag)) report(ref, FIX.embed);
        else if (IMAGE_TAGS.has(tag) || name === "poster" || name === "background") report(ref, FIX.image);
        else report(ref, FIX.image);
      }
    }
  }
}

/** External http(s) references in a site's HTML, CSS and JS files, with the fix for each. */
export function findExternalRefs(files) {
  const out = [];
  for (const file of files) {
    const mime = mimeOf(file.path);
    if (!["text/html", "text/css", "text/javascript", "image/svg+xml"].includes(mime)) continue;
    const text = file.bytes.toString("utf8");
    if (mime === "text/html" || mime === "image/svg+xml") scanHtml(file.path, text, out);
    else if (mime === "text/css") scanCss(file.path, text, 0, text, out);
    else scanJs(file.path, text, 0, text, out);
  }
  return out;
}

/**
 * Everything ava would refuse, found before the upload: the entry, ava's
 * size limits, and external references. Throws one ArtifactsError listing all
 * of them; returns nothing when the site is fine.
 */
export function validateSite(files, limits = LIMITS) {
  const problems = [];
  const paths = new Set();
  for (const file of files) {
    if (paths.has(file.path)) problems.push(`"${file.path}" appears twice.`);
    paths.add(file.path);
  }
  if (!paths.has(ENTRY)) problems.push(`There is no ${ENTRY}: the page's entry must be a file named index.html at the top of the upload.`);
  for (const file of files) {
    if (file.bytes.length > limits.maxFileBytes) {
      problems.push(`${file.path} is ${fmtBytes(file.bytes.length)}; the limit is ${fmtBytes(limits.maxFileBytes)} per file. Compress or downscale images, drop unused code, or split data out.`);
    }
  }
  const deps = files.filter((file) => file.path !== ENTRY);
  if (deps.length > limits.maxDeps) problems.push(`${deps.length} files besides index.html; the limit is ${limits.maxDeps}. Inline small assets into index.html or drop unused ones.`);
  const depBytes = deps.reduce((sum, file) => sum + file.bytes.length, 0);
  if (depBytes > limits.maxDepsBytes) problems.push(`The files besides index.html total ${fmtBytes(depBytes)}; the limit is ${fmtBytes(limits.maxDepsBytes)}.`);
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > limits.maxShareBytes) problems.push(`The page totals ${fmtBytes(total)}; the limit is ${fmtBytes(limits.maxShareBytes)} per page.`);
  if (problems.length > 0) {
    throw new ArtifactsError("too_large", `Not published: ${problems.join(" ")}`);
  }
  const refs = findExternalRefs(files);
  if (refs.length > 0) {
    const shown = refs.slice(0, 20).map((ref) => `- ${ref.file}:${ref.line} ${ref.what} ${clip(ref.ref)} -> ${ref.fix}`);
    if (refs.length > shown.length) shown.push(`- … and ${refs.length - shown.length} more`);
    throw new ArtifactsError(
      "external_ref",
      `Not published: ${refs.length} external reference${refs.length === 1 ? "" : "s"}. Pages are inline-only: the viewer loads nothing from the network, so every script, style, font, image and data file must be inside the upload.\n${shown.join("\n")}\nFix these and publish again.`,
      { refs },
    );
  }
}

/** The page's own `<title>`, for a publish that names none. */
export function titleOf(files) {
  const entry = files.find((file) => file.path === ENTRY);
  const match = entry?.bytes.toString("utf8").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1].replace(/\s+/g, " ").trim();
  return title || null;
}

export function toUpload(files) {
  return files.map((file) => ({ path: file.path, mime: mimeOf(file.path), contentBase64: file.bytes.toString("base64") }));
}

/**
 * The current version's files with `ours` laid over them (same path wins).
 * Used to retry a conflicting update when the caller asked to merge.
 */
export function mergeFiles(current, ours) {
  const merged = new Map();
  for (const file of current ?? []) {
    if (file?.path && typeof file.contentBase64 === "string") merged.set(file.path, { path: file.path, bytes: Buffer.from(file.contentBase64, "base64") });
  }
  for (const file of ours) merged.set(file.path, file);
  return [...merged.values()];
}

// --- HTTP -------------------------------------------------------------------

const ERROR_HINTS = {
  too_large: "The page is over ava's limits (4 MiB per file, 12 MiB and 48 files besides index.html, 16 MiB per page).",
  external_ref: "ava found an external reference; inline it (pages are inline-only).",
  quota_exceeded: "The account's artifact quota is full: delete pages you no longer need (action list, then delete — only with the user's go-ahead) or ask the user to free space in ava's gallery.",
  version_conflict: "The page changed since this version.",
};

/** The routes under `/api/agent-next/artifacts`. */
export class ArtifactsClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    // Not enumerable: an accidental JSON.stringify(client) does not show it.
    Object.defineProperty(this, "apiKey", { value: apiKey, enumerable: false });
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /** An absolute viewer URL (ava may answer with a path). */
  absolute(url) {
    if (!url) return url;
    return /^https?:\/\//i.test(url) ? url : `${this.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  async request(method, path, body) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${ROUTE}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ArtifactsError("network", `Could not reach ${this.baseUrl}: ${error?.cause?.code ?? error?.message ?? error}`);
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Reported with the status below.
    }
    if (response.ok) return json;
    throw this.errorOf(response.status, json, text);
  }

  errorOf(status, json, text) {
    const code = json?.error?.code ?? (status === 409 ? "version_conflict" : `http_${status}`);
    const serverMessage = String(json?.error?.message ?? "").split(this.apiKey).join("[key]");
    if (code === "version_conflict") {
      const current = Number(json?.error?.currentVersion ?? json?.currentVersion ?? json?.error?.version ?? json?.version);
      return new ArtifactsError(code, serverMessage || "version conflict", { status, currentVersion: Number.isFinite(current) ? current : null });
    }
    if (status === 401 || status === 403) {
      return new ArtifactsError(
        "unauthorized",
        `ava refused the Rabi key (HTTP ${status}${serverMessage ? `: ${serverMessage}` : ""}). Publishing needs a desktop key with the \`artifacts\` scope, which keys granted before artifacts existed do not have: run \`unieai login --rabi\` again to re-grant.`,
        { status },
      );
    }
    if (status === 404 && !json?.error) {
      return new ArtifactsError("not_found", `${this.baseUrl} answered 404 (not found): the artifact does not exist, or this ava deployment does not serve artifact publishing yet.`, { status });
    }
    const hint = ERROR_HINTS[code];
    const detail = serverMessage || clip(String(text ?? "").split(this.apiKey).join("[key]"), 300) || `HTTP ${status}`;
    return new ArtifactsError(code, hint ? `${detail} ${hint}` : `ava answered HTTP ${status}: ${detail}`, { status });
  }

  create(body) {
    return this.request("POST", "/site", body);
  }

  update(id, body, expectedVersion) {
    return this.request("PUT", `/${encodeURIComponent(id)}`, { ...body, expectedVersion });
  }

  async list() {
    const json = await this.request("GET", `?mine=1&source=${SOURCE}`);
    return Array.isArray(json) ? json : (json?.artifacts ?? json?.items ?? []);
  }

  get(id) {
    return this.request("GET", `/${encodeURIComponent(id)}`);
  }

  remove(id) {
    return this.request("DELETE", `/${encodeURIComponent(id)}`);
  }
}

// --- id memory --------------------------------------------------------------

/** The workspace a session's paths are remembered under: the git root, else the directory itself. */
export function workspaceRoot(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/**
 * `$UNIEAI_HOME/artifacts.json`:
 * `{ version: 1, workspaces: { <root>: { <path relative to root>: {id, account, viewerUrl, version, title, updatedAt} } } }`.
 * Entries of another account are ignored (a Rabi re-login as someone else).
 */
export class IdMemory {
  constructor(home = unieaiHome()) {
    this.file = join(home, MEMORY_FILE);
  }

  load() {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (data && typeof data.workspaces === "object") return data;
    } catch {
      // Missing or unreadable: start over.
    }
    return { version: 1, workspaces: {} };
  }

  save(data) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  static key(workspace, absPath) {
    const rel = relative(workspace, absPath);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : absPath;
  }

  lookup(workspace, absPath, account) {
    const entry = this.load().workspaces[workspace]?.[IdMemory.key(workspace, absPath)];
    return entry && entry.account === account ? entry : null;
  }

  remember(workspace, absPath, entry) {
    const data = this.load();
    const key = IdMemory.key(workspace, absPath);
    // One path per id in a workspace: the page moved with its newest source.
    const paths = (data.workspaces[workspace] ??= {});
    for (const [path, other] of Object.entries(paths)) if (other.id === entry.id && path !== key) delete paths[path];
    paths[key] = { ...entry, updatedAt: new Date().toISOString() };
    this.save(data);
  }

  /** Local paths remembered for `id`, as `{workspace, path}`. */
  pathsOf(id) {
    const out = [];
    for (const [workspace, paths] of Object.entries(this.load().workspaces)) {
      for (const [path, entry] of Object.entries(paths)) if (entry.id === id) out.push({ workspace, path, entry });
    }
    return out;
  }

  /** Records the version just published wherever `id` is remembered. */
  touch(id, version) {
    const data = this.load();
    let changed = false;
    for (const paths of Object.values(data.workspaces)) {
      for (const entry of Object.values(paths)) {
        if (entry.id === id) {
          entry.version = version;
          changed = true;
        }
      }
    }
    if (changed) this.save(data);
  }

  forget(id) {
    const data = this.load();
    let changed = false;
    for (const [workspace, paths] of Object.entries(data.workspaces)) {
      for (const [path, entry] of Object.entries(paths)) {
        if (entry.id === id) {
          delete paths[path];
          changed = true;
        }
      }
      if (Object.keys(paths).length === 0) delete data.workspaces[workspace];
    }
    if (changed) this.save(data);
    return changed;
  }
}

// --- the actions ------------------------------------------------------------

const VISIBILITIES = new Set(["private", "org"]);

function headerOf(header) {
  if (!header || typeof header !== "object") return undefined;
  const out = {};
  for (const key of ["title", "description", "icon"]) if (typeof header[key] === "string" && header[key].trim()) out[key] = header[key].trim();
  const showAuthor = header.show_author ?? header.showAuthor;
  if (typeof showAuthor === "boolean") out.showAuthor = showAuthor;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Publish (create or update in place).
 * @param {object} options
 * @param {ArtifactsClient} options.client
 * @param {IdMemory} options.memory
 * @param {string} options.account - from resolveAccount, to scope the memory.
 * @param {string} options.cwd - where a relative `path` resolves.
 * @param {string} [options.workspace] - the root paths are remembered under (default: git root of cwd).
 * @param {object} options.args - the tool's arguments.
 */
export async function publish({ client, memory, account, cwd, workspace = workspaceRoot(cwd), args }) {
  if (args.path && args.files) throw new ArtifactsError("bad_request", "Pass either path or files, not both.");
  if (!args.path && !args.files) throw new ArtifactsError("bad_request", "publish needs path (an .html file or a directory with index.html) or files.");
  const visibility = args.visibility ?? "private";
  if (!VISIBILITIES.has(visibility)) {
    throw new ArtifactsError("bad_request", `visibility must be "private" or "org"; making a page public is done by the user in ava's web UI.`);
  }
  const absPath = args.path ? resolve(cwd, args.path) : null;
  const files = absPath ? collectFromPath(absPath) : collectInline(args.files);
  validateSite(files);

  const remembered = absPath ? memory.lookup(workspace, absPath, account) : null;
  let id = args.id ?? remembered?.id ?? null;
  const title = String(args.title ?? "").trim() || titleOf(files) || remembered?.title || (absPath ? basename(absPath) : "Untitled page");
  const body = { title, entry: ENTRY, files: toUpload(files), visibility };
  if (args.description) body.description = String(args.description);
  const header = headerOf(args.header);
  if (header) body.header = header;

  let result;
  let mode = "created";
  let merged = false;
  if (!id) {
    result = await client.create(body);
  } else {
    mode = "updated";
    let expected = Number.isFinite(args.expected_version) ? args.expected_version : remembered?.id === id ? remembered.version : undefined;
    try {
      if (expected === undefined) expected = (await client.get(id))?.version;
      result = await client.update(id, body, expected);
    } catch (error) {
      if (error.code === "not_found" && !args.id) {
        // The remembered page is gone (deleted in ava): publish a new one.
        memory.forget(id);
        id = null;
        mode = "created";
        result = await client.create(body);
      } else if (error.code === "version_conflict" && args.merge) {
        const current = await client.get(id);
        const mergedFiles = mergeFiles(current?.files, files);
        validateSite(mergedFiles);
        try {
          result = await client.update(id, { ...body, files: toUpload(mergedFiles) }, current?.version ?? error.currentVersion);
        } catch (again) {
          if (again.code === "version_conflict") {
            throw new ArtifactsError("version_conflict", `Artifact ${id} changed again while merging (now version ${again.currentVersion ?? "?"}). Read it (action read), merge by hand, and publish with expected_version.`, { currentVersion: again.currentVersion });
          }
          throw again;
        }
        merged = true;
      } else if (error.code === "version_conflict") {
        throw new ArtifactsError(
          "version_conflict",
          `Not published: artifact ${id} is at version ${error.currentVersion ?? "?"}, but this update was based on version ${expected ?? "?"} — it was changed elsewhere (ava's web UI or another session). ` +
            `Read it (action read, with save_to to get the files), merge your changes into that version, and publish again with expected_version ${error.currentVersion ?? "<current>"}; ` +
            "or publish again with merge: true to lay your files over the current version's (same path wins).",
          { currentVersion: error.currentVersion },
        );
      } else {
        throw error;
      }
    }
  }
  const out = {
    id: String(result?.id ?? id),
    viewerUrl: client.absolute(result?.viewerUrl ?? result?.url ?? ""),
    version: Number(result?.version ?? 1),
    title,
    visibility,
    mode,
    merged,
    files: files.length,
  };
  if (absPath) memory.remember(workspace, absPath, { id: out.id, account, viewerUrl: out.viewerUrl, version: out.version, title });
  else memory.touch(out.id, out.version);
  return out;
}

export function renderPublished(out) {
  const verb = out.mode === "created" ? "Published a new page" : out.merged ? "Merged with the current version and updated the page in place" : "Updated the page in place";
  return [
    `${verb}: "${out.title}"`,
    out.viewerUrl,
    `id ${out.id} · version ${out.version} · ${out.visibility} · ${out.files} file${out.files === 1 ? "" : "s"}`,
    "Give the user this link once. To change the page later, edit the same file and publish it again (it updates this page in place).",
  ].join("\n");
}

export async function list({ client, memory }) {
  const items = await client.list();
  return items.map((item) => ({
    id: String(item.id),
    title: String(item.title ?? ""),
    url: client.absolute(item.url ?? item.viewerUrl ?? ""),
    version: item.version ?? null,
    updatedAt: item.updatedAt ?? null,
    local: memory.pathsOf(String(item.id)).map(({ workspace, path }) => (isAbsolute(path) ? path : join(workspace, path))),
  }));
}

export function renderList(items) {
  if (items.length === 0) return "No artifacts published from UnieAI Code on this account yet.";
  const lines = items.map((item) => {
    const meta = [`id ${item.id}`, item.version != null ? `version ${item.version}` : null, item.updatedAt ? `updated ${item.updatedAt}` : null].filter(Boolean).join(" · ");
    const local = item.local.length > 0 ? `\n   from ${item.local.join(", ")}` : "";
    return `- "${item.title}" ${item.url}\n   ${meta}${local}`;
  });
  return `${items.length} artifact${items.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

const READ_TEXT_LIMIT = 64 * 1024;
const READ_TOTAL_LIMIT = 200 * 1024;

/** Metadata and files; with `saveTo`, the files are written there and that directory remembered for the id. */
export async function read({ client, memory, account, cwd, workspace = workspaceRoot(cwd), id, saveTo }) {
  const meta = await client.get(id);
  const files = Array.isArray(meta?.files) ? meta.files : [];
  let savedDir = null;
  if (saveTo) {
    savedDir = resolve(cwd, saveTo);
    for (const file of files) {
      const path = normalizeSitePath(file.path);
      const target = join(savedDir, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(String(file.contentBase64 ?? ""), "base64"));
    }
    memory.remember(workspace, savedDir, { id: String(meta?.id ?? id), account, viewerUrl: client.absolute(meta?.viewerUrl ?? meta?.url ?? ""), version: meta?.version ?? null, title: meta?.title ?? "" });
  }
  return { meta, files, savedDir };
}

export function renderRead({ meta, files, savedDir }, client) {
  const lines = [
    `"${meta?.title ?? ""}" ${client.absolute(meta?.viewerUrl ?? meta?.url ?? "")}`,
    `id ${meta?.id} · version ${meta?.version ?? "?"} · ${meta?.visibility ?? "?"}${meta?.updatedAt ? ` · updated ${meta.updatedAt}` : ""}`,
  ];
  if (meta?.description) lines.push(`description: ${meta.description}`);
  if (meta?.header) lines.push(`header: ${JSON.stringify(meta.header)}`);
  if (savedDir) lines.push(`Saved ${files.length} file${files.length === 1 ? "" : "s"} to ${savedDir}; publish that directory to update this page in place (expected_version ${meta?.version}).`);
  let budget = READ_TOTAL_LIMIT;
  for (const file of files) {
    const bytes = Buffer.from(String(file.contentBase64 ?? ""), "base64");
    const mime = file.mime ?? mimeOf(file.path);
    if (!isText(mime)) {
      lines.push(`\n--- ${file.path} (${mime}, ${fmtBytes(bytes.length)}, binary)`);
      continue;
    }
    const text = bytes.toString("utf8");
    const room = Math.min(READ_TEXT_LIMIT, budget);
    if (room <= 0) {
      lines.push(`\n--- ${file.path} (${fmtBytes(bytes.length)}, not shown: output budget used${savedDir ? "" : "; read with save_to"})`);
      continue;
    }
    const shown = text.length > room ? `${text.slice(0, room)}\n… (${fmtBytes(bytes.length)} in all${savedDir ? "" : "; read with save_to for the rest"})` : text;
    budget -= Math.min(text.length, room);
    lines.push(`\n--- ${file.path} (${mime})\n${shown}`);
  }
  return lines.join("\n");
}

export async function remove({ client, memory, id }) {
  await client.remove(id);
  memory.forget(id);
  return `Deleted artifact ${id}; its link no longer works.`;
}
