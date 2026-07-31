import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodingTools } from "./tools.mjs";
import { readSpilled } from "./tool-output-store.mjs";

const RECORDS = 10_000;

function apiBody() {
  return JSON.stringify(
    Array.from({ length: RECORDS }, (_, i) => ({ id: i, name: `user-${i}`, email: `user-${i}@example.com` })),
  )
}

async function fetchTool(body) {
  const tools = await buildCodingTools({ workspace: process.cwd(), webAccess: true })()
  const realFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } })
  return { fetch: tools.executors.fetch, restore: () => { globalThis.fetch = realFetch } }
}

test("a 10k-record response is preserved whole, not cut in half", async () => {
  const { fetch, restore } = await fetchTool(apiBody())
  try {
    const r = await fetch({ url: "https://api.example.com/users" })
    assert.equal(r.ok, true)

    // The model sees a shape summary, not a slab of records.
    assert.match(r.modelText, new RegExp(`${RECORDS} records`))
    assert.match(r.modelText, /fields: id, name, email/)
    assert.ok(r.modelText.length < 2500, `preview was ${r.modelText.length} chars`)

    // And the data is genuinely still there — the old hard truncation destroyed
    // everything between the first and last 12k characters.
    const id = r.modelText.match(/read_output\("([^"]+)"/)?.[1]
    assert.ok(id, `no retrieval id in preview: ${r.modelText}`)

    const middle = readSpilled(id, { offset: 5000, limit: 2 })
    const page = JSON.parse(middle.text.slice(middle.text.indexOf("[")))
    assert.equal(page[0].id, 5000, "the middle of the response survived")

    const tail = readSpilled(id, { offset: RECORDS - 1, limit: 1 })
    assert.equal(JSON.parse(tail.text.slice(tail.text.indexOf("[")))[0].id, RECORDS - 1)
  } finally {
    restore()
  }
})

test("a small response is returned inline, with no store round trip", async () => {
  const { fetch, restore } = await fetchTool(JSON.stringify([{ id: 1 }]))
  try {
    const r = await fetch({ url: "https://api.example.com/one" })
    assert.match(r.modelText, /\[\{"id":1\}\]/)
    assert.ok(!r.modelText.includes("read_output"), "no need to offer retrieval for a small body")
  } finally {
    restore()
  }
})

test("a large HTML page still spills as text, keeping the head/tail preview", async () => {
  const html = `<html><body>${"<p>filler</p>".repeat(5000)}</body></html>`
  const { fetch, restore } = await fetchTool(html)
  try {
    const r = await fetch({ url: "https://example.com/big" })
    // Not record data, so the text preview shape applies.
    assert.match(r.modelText, /chars total — full output saved/)
    const id = r.modelText.match(/read_output\("([^"]+)"/)?.[1]
    assert.ok(id, "a spilled page must still be retrievable")
  } finally {
    restore()
  }
})
