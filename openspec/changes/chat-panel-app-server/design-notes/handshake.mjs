#!/usr/bin/env node
// Minimal app-server handshake proof: initialize -> thread/start ->
// turn/start -> stream notifications until turn/completed.
// Usage: CODEX_HOME=<home> node handshake.mjs <binary> <model>
import { spawn } from "node:child_process"

const [bin = "codex", model = "Qwen3.6-35B-A3B"] = process.argv.slice(2)
const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "inherit"] })

let nextId = 1
const pending = new Map()
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
  })
}

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
      console.log("[raw]", line.slice(0, 200))
      continue
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = pending.get(msg.id)
      if (waiter) {
        pending.delete(msg.id)
        msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result)
        continue
      }
    }
    if (msg.method && msg.id !== undefined) {
      console.log("[server-request]", msg.method, JSON.stringify(msg.params).slice(0, 160))
      // Auto-accept any approval so the smoke run completes.
      child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: "accept" } }) + "\n")
      continue
    }
    if (msg.method) {
      const p = JSON.stringify(msg.params ?? {})
      console.log("[notify]", msg.method, p.length > 160 ? p.slice(0, 160) + "…" : p)
      if (msg.method === "turn/completed" || msg.method === "turn/failed") {
        setTimeout(() => process.exit(0), 100)
      }
    }
  }
})

const init = await request("initialize", {
  clientInfo: { name: "unieai-vscode-handshake", title: "handshake", version: "0.0.1" },
  capabilities: { experimentalApi: true },
})
console.log("[initialize ok]", JSON.stringify(init).slice(0, 200))

const thread = await request("thread/start", {
  model,
  cwd: process.env.CODEX_HOME,
  approvalPolicy: "never",
  sandbox: "read-only",
  ephemeral: true,
})
const threadId = thread.thread_id ?? thread.threadId ?? thread?.thread?.id
console.log("[thread/start ok]", JSON.stringify(thread).slice(0, 300))

const turn = await request("turn/start", {
  threadId,
  thread_id: threadId,
  input: [{ type: "text", text: "Reply with exactly: HANDSHAKE OK" }],
})
console.log("[turn/start ok]", JSON.stringify(turn).slice(0, 200))

setTimeout(() => {
  console.log("[timeout]")
  process.exit(1)
}, 120000)
