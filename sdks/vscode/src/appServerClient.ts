import { ChildProcessWithoutNullStreams, spawn } from "node:child_process"

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any

/** JSONL JSON-RPC client for `unieai app-server`.
 *
 * Envelope (no `jsonrpc` field): request `{id, method, params}`, response
 * `{id, result|error}`, notification `{method, params}`. The server also
 * sends its own requests (approvals) which we answer via `respond`. */
export class AppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private nextId = 1
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>()
  private buffered = ""

  onNotification: (method: string, params: Json) => void = () => {}
  /** Handle a server->client request; the returned value is sent as result. */
  onServerRequest: (method: string, params: Json, requestId: Json) => void = () => {}
  onExit: (code: number | null) => void = () => {}

  constructor(
    private readonly executable: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  get alive(): boolean {
    return Boolean(this.child && this.child.exitCode === null)
  }

  async start(): Promise<void> {
    const child = spawn(this.executable, ["app-server"], {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child = child

    // The writable check in write() races the server dying; an EPIPE on stdin
    // with no listener would crash the extension host.
    child.stdin.on("error", () => {})
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.onData(chunk))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", () => {
      /* server logs; intentionally not surfaced */
    })
    child.once("exit", (code) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error("app-server exited"))
      }
      this.pending.clear()
      this.onExit(code)
    })

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve())
      child.once("error", (err) => reject(err))
    })
  }

  private onData(chunk: string) {
    this.buffered += chunk
    let newline = this.buffered.indexOf("\n")
    while (newline !== -1) {
      const line = this.buffered.slice(0, newline).trim()
      this.buffered = this.buffered.slice(newline + 1)
      newline = this.buffered.indexOf("\n")
      if (!line) {
        continue
      }
      let message: Json
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Json) {
    const hasId = message.id !== undefined && message.id !== null
    if (hasId && (message.result !== undefined || message.error !== undefined)) {
      const waiter = this.pending.get(message.id)
      if (waiter) {
        this.pending.delete(message.id)
        if (message.error !== undefined) {
          waiter.reject(new Error(JSON.stringify(message.error)))
        } else {
          waiter.resolve(message.result)
        }
      }
      return
    }
    if (hasId && typeof message.method === "string") {
      this.onServerRequest(message.method, message.params, message.id)
      return
    }
    if (typeof message.method === "string") {
      this.onNotification(message.method, message.params)
    }
  }

  private write(payload: Json) {
    if (!this.child?.stdin.writable) {
      throw new Error("app-server stdin not writable")
    }
    this.child.stdin.write(JSON.stringify(payload) + "\n")
  }

  request(method: string, params: Json, timeoutMs = 30_000): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      try {
        this.write({ id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err as Error)
      }
    })
  }

  /** Answer a server->client request. */
  respond(requestId: Json, result: Json) {
    try {
      this.write({ id: requestId, result })
    } catch {
      /* server is gone; nothing to do */
    }
  }

  dispose() {
    if (this.child) {
      this.child.removeAllListeners("exit")
      this.child.kill("SIGTERM")
      this.child = undefined
    }
  }
}
