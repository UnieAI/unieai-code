const { test } = require("node:test")
const assert = require("node:assert/strict")
const { describeLifetime, describeProcess, summarizeProcesses } = require("./backgroundProcesses.cjs")

/** A snapshot in the shape process-manager.mjs actually produces. */
function snapshot(overrides = {}) {
  return {
    id: "bg_1",
    command: "npm run dev",
    pid: 1234,
    status: "running",
    exitCode: null,
    signal: null,
    uptimeMs: 12_000,
    outputLines: 40,
    droppedLines: 0,
    ...overrides,
  }
}

test("a live process is described by uptime, a dead one by how it died", () => {
  assert.equal(describeLifetime(snapshot()), "up 12s")
  assert.equal(describeLifetime(snapshot({ status: "exited", exitCode: 0, uptimeMs: 900 })), "exit 0")
  assert.equal(describeLifetime(snapshot({ status: "exited", exitCode: 1 })), "exit 1")
  assert.equal(describeLifetime(snapshot({ status: "killed", exitCode: null, signal: "SIGTERM" })), "exit SIGTERM")
})

test("an exit code of 0 is shown, not swallowed by a falsy check", () => {
  // The classic bug: `exitCode || signal` turns a clean exit into "exit ?".
  assert.ok(describeProcess(snapshot({ status: "exited", exitCode: 0 })).includes("exit 0"))
})

test("dropped lines are surfaced — output the user can no longer read is not silently omitted", () => {
  assert.ok(describeProcess(snapshot({ outputLines: 5000, droppedLines: 3000 })).includes("(+3000 dropped)"))
  assert.equal(describeProcess(snapshot()).includes("dropped"), false)
})

test("a long command line is truncated so a row stays one line", () => {
  const row = describeProcess(snapshot({ command: "x".repeat(500) }))
  assert.ok(row.length < 200)
})

test("nothing running means no indicator at all", () => {
  assert.equal(summarizeProcesses([]), null)
  assert.equal(summarizeProcesses(null), null)
  // Exited processes stay listable for their retention window, but a badge over
  // them would claim work is still in flight when it finished minutes ago.
  assert.equal(summarizeProcesses([snapshot({ status: "exited", exitCode: 0 })]), null)
})

test("the badge counts only what is still running", () => {
  const summary = summarizeProcesses([
    snapshot({ id: "bg_1" }),
    snapshot({ id: "bg_2", status: "exited", exitCode: 0 }),
    snapshot({ id: "bg_3", command: "cargo watch" }),
  ])
  assert.equal(summary.running, 2)
  assert.equal(summary.text, "$(pulse) 2")
  assert.ok(summary.tooltip.includes("bg_1"))
  assert.ok(summary.tooltip.includes("bg_3"))
  assert.equal(summary.tooltip.includes("bg_2"), false)
})

test("a long tooltip is capped rather than listing every process", () => {
  const many = Array.from({ length: 20 }, (_, i) => snapshot({ id: `bg_${i}` }))
  const summary = summarizeProcesses(many)
  assert.equal(summary.running, 20)
  assert.ok(summary.tooltip.includes("and 12 more"))
})
