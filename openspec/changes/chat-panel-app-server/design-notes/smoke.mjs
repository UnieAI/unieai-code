#!/usr/bin/env node
// Full smoke of the extension's app-server call sequences:
// approval round-trip, settings update, interrupt.
// Usage: CODEX_HOME=<home> node smoke.mjs <binary> <model>
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [bin = "codex", model = "Qwen3.6-35B-A3B"] = process.argv.slice(2)
const cwd = mkdtempSync(join(tmpdir(), "unieai-smoke-"))
const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] })

let nextId = 1
const pending = new Map()
const request = (method, params, timeout = 120000) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    const t = setTimeout(() => reject(new Error(method + " timeout")), timeout)
    pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject })
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
  })

let approvalSeen = false
let commandOutput = ""
let turnCompletions = 0
const waiters = []
const waitFor = (pred) => new Promise((resolve) => waiters.push({ pred, resolve }))

let buffered = ""
child.stdout.on("data", (chunk) => {
  buffered += chunk
  let nl
  while ((nl = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, nl).trim()
    buffered = buffered.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const w = pending.get(msg.id)
      if (w) {
        pending.delete(msg.id)
        msg.error ? w.reject(new Error(JSON.stringify(msg.error).slice(0, 300))) : w.resolve(msg.result)
      }
      continue
    }
    if (msg.method && msg.id !== undefined) {
      console.log("[server-request]", msg.method)
      if (msg.method === "item/commandExecution/requestApproval") {
        approvalSeen = true
        child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: "accept" } }) + "\n")
      } else {
        child.stdin.write(JSON.stringify({ id: msg.id, result: {} }) + "\n")
      }
      continue
    }
    if (msg.method === "item/completed" && msg.params?.item?.type === "commandExecution") {
      commandOutput += msg.params.item.aggregatedOutput ?? ""
    }
    if (msg.method === "turn/completed") {
      turnCompletions += 1
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg)
        waiters.splice(i, 1)
      }
    }
  }
})

const fail = (why) => {
  console.error("SMOKE FAIL:", why)
  child.kill()
  process.exit(1)
}

await request("initialize", {
  clientInfo: { name: "unieai-code-vscode", title: "UnieAI Code", version: "0.9.0" },
  capabilities: { experimentalApi: true },
})

// 1. Thread with on-request approvals + network access config.
const started = await request("thread/start", {
  model,
  cwd,
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  config: { "sandbox_workspace_write.network_access": true },
})
const threadId = started?.thread?.id
if (!threadId) fail("no thread id")
console.log("[ok] thread/start", threadId)

// 2. A turn that must trigger a command approval.
await request("turn/start", {
  threadId,
  input: [{ type: "text", text: "Use the shell tool to create the file $HOME/unieai-smoke-approval/proof.txt containing APPROVAL_TEST_123 (mkdir -p first). This is outside the workspace so it requires escalated permissions - request them. Then reply DONE." }],
})
await waitFor((m) => m.method === "turn/completed")
if (!approvalSeen) fail("no approval request was raised")
console.log("[ok] approval round-trip")

// 3. Settings update (permission pill switch mid-thread).
await request("thread/settings/update", {
  threadId,
  approvalPolicy: "never",
  sandbox: "read-only",
})
console.log("[ok] thread/settings/update")

// 4. Interrupt a fresh turn.
const turn = await request("turn/start", {
  threadId,
  input: [{ type: "text", text: "Count slowly from 1 to 50, one number per line." }],
})
const turnId = turn?.turn?.id
setTimeout(() => {
  request("turn/interrupt", { threadId, turnId }).catch(() => {})
}, 1500)
const done = await waitFor((m) => m.method === "turn/completed")
console.log("[ok] interrupt; final turn status:", done.params?.turn?.status)

console.log("SMOKE PASS")
child.kill()
process.exit(0)
