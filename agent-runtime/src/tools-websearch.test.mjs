import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodingTools, SEARCH_PROVIDERS } from "./tools.mjs";

async function searchTool({ webAccess = true } = {}) {
  const t = await buildCodingTools({ workspace: process.cwd(), webAccess })();
  return t;
}

/** Swap env for one call and always put it back. */
async function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("web_search is registered only when web access is on", async () => {
  const on = await searchTool({ webAccess: true });
  assert.ok(on.schemas.some((s) => s.function.name === "web_search"));
  const off = await searchTool({ webAccess: false });
  assert.ok(!off.schemas.some((s) => s.function.name === "web_search"));
});

test("web_search refuses when web access is disabled", async () => {
  const t = await buildCodingTools({ workspace: process.cwd(), webAccess: false })();
  const r = await t.executors.web_search({ query: "anything" });
  assert.equal(r.ok, false);
  assert.match(r.modelText, /web access is disabled/);
});

test("web_search requires a query", async () => {
  const t = await searchTool();
  const r = await t.executors.web_search({});
  assert.equal(r.ok, false);
  assert.match(r.modelText, /query is required/);
});

test("web_search explains how to configure itself when unset", async () => {
  const t = await searchTool();
  const r = await withEnv({ UNIEAI_SEARCH_PROVIDER: null, UNIEAI_SEARCH_API_KEY: null }, () =>
    t.executors.web_search({ query: "ripgrep docs" })
  );
  assert.equal(r.ok, false);
  assert.match(r.modelText, /UNIEAI_SEARCH_PROVIDER/);
  assert.match(r.modelText, /UNIEAI_SEARCH_API_KEY/);
  // The model should be told what it can still do instead of just failing.
  assert.match(r.modelText, /use fetch/i);
});

test("web_search rejects an unknown provider by name", async () => {
  const t = await searchTool();
  const r = await withEnv({ UNIEAI_SEARCH_PROVIDER: "altavista", UNIEAI_SEARCH_API_KEY: "k" }, () =>
    t.executors.web_search({ query: "x" })
  );
  assert.equal(r.ok, false);
  assert.match(r.modelText, /unknown UNIEAI_SEARCH_PROVIDER "altavista"/);
  assert.match(r.modelText, /brave/);
});

test("both shipped providers normalize to title/url/snippet", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("brave")
            ? { web: { results: [{ title: "B", url: "https://b.example", description: "<b>desc</b>" }] } }
            : { results: [{ title: "T", url: "https://t.example", content: "content" }] }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );

    const brave = await SEARCH_PROVIDERS.brave({ query: "q", limit: 5, apiKey: "k" });
    assert.deepEqual(brave, [{ title: "B", url: "https://b.example", snippet: "desc" }]);

    const tavily = await SEARCH_PROVIDERS.tavily({ query: "q", limit: 5, apiKey: "k" });
    assert.deepEqual(tavily, [{ title: "T", url: "https://t.example", snippet: "content" }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("web_search renders results as a numbered list of title/url/snippet", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ web: { results: [{ title: "Ripgrep", url: "https://rg.example", description: "fast search" }] } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const t = await searchTool();
    const r = await withEnv({ UNIEAI_SEARCH_PROVIDER: "brave", UNIEAI_SEARCH_API_KEY: "k" }, () =>
      t.executors.web_search({ query: "ripgrep" })
    );
    assert.equal(r.ok, true);
    assert.match(r.modelText, /1\. Ripgrep/);
    assert.match(r.modelText, /https:\/\/rg\.example/);
    assert.match(r.modelText, /fast search/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a provider HTTP error surfaces as a tool error, not a throw", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("nope", { status: 401, statusText: "Unauthorized" });
    const t = await searchTool();
    const r = await withEnv({ UNIEAI_SEARCH_PROVIDER: "brave", UNIEAI_SEARCH_API_KEY: "bad" }, () =>
      t.executors.web_search({ query: "x" })
    );
    assert.equal(r.ok, false);
    assert.match(r.modelText, /HTTP 401/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
