import { ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { AppServerClient, Json } from "./appServerClient"
import { AgentCoreBackend } from "./agentCoreBackend"

const TERMINAL_NAME = "unieai"

/** Model entry stored by `unieai login` in $UNIEAI_HOME/unieai.json. */
type StoredModel = { id: string; name?: string }

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatViewProvider(context)

  context.subscriptions.push(
    { dispose: () => provider.dispose() },
    vscode.window.registerWebviewViewProvider("unieai-code.chatView", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("unieai-code.focusChat", async () => {
      await vscode.commands.executeCommand("unieai-code.chatView.focus")
    }),
    vscode.commands.registerCommand("unieai-code.newChat", () => {
      provider.newChat()
    }),
    vscode.commands.registerCommand("unieai-code.addFilepathToChat", async () => {
      const fileRef = getActiveFileRef()
      if (!fileRef) {
        return
      }
      await vscode.commands.executeCommand("unieai-code.chatView.focus")
      provider.insertText(`${fileRef} `)
    }),
    vscode.commands.registerCommand("unieai-code.openTerminal", () => {
      const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
      if (existing) {
        existing.show()
        return
      }
      const terminal = vscode.window.createTerminal({
        name: TERMINAL_NAME,
        location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        env: { UNIEAI_CALLER: "vscode" },
      })
      terminal.show()
      terminal.sendText(executablePath())
    }),
  )
}

function executablePath(): string {
  const configured = vscode.workspace.getConfiguration("unieai-code").get<string>("executablePath")
  // A stale absolute path (e.g. a deleted dev-build binary) must not brick every
  // shell call — fall back to resolving `unieai` rather than spawning a path we
  // can already see is gone. Relative/bare names go to spawn's PATH lookup as-is.
  if (configured && (!path.isAbsolute(configured) || fs.existsSync(configured))) {
    return configured
  }
  if (configured) {
    console.warn(`unieai-code.executablePath does not exist: ${configured}; falling back to \`unieai\``)
  }
  return "unieai"
}

function unieaiHome(): string {
  return (
    process.env["UNIEAI_HOME"] || process.env["CODEX_HOME"] || path.join(os.homedir(), ".unieai")
  )
}

function loadStoredModels(): { models: StoredModel[]; signedIn: boolean } {
  try {
    const raw = fs.readFileSync(path.join(unieaiHome(), "unieai.json"), "utf8")
    const parsed = JSON.parse(raw) as {
      available_models?: StoredModel[]
      available_model_ids?: string[]
    }
    const models =
      parsed.available_models ??
      (parsed.available_model_ids ?? []).map((id) => ({ id }) as StoredModel)
    return { models, signedIn: true }
  } catch {
    return { models: [], signedIn: false }
  }
}

function getActiveFileRef(): string | undefined {
  const activeEditor = vscode.window.activeTextEditor
  if (!activeEditor) {
    return
  }
  const relativePath = vscode.workspace.asRelativePath(activeEditor.document.uri)
  let ref = `@${relativePath}`
  const selection = activeEditor.selection
  if (!selection.isEmpty) {
    const startLine = selection.start.line + 1
    const endLine = selection.end.line + 1
    ref += startLine === endLine ? `#L${startLine}` : `#L${startLine}-${endLine}`
  }
  return ref
}

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private loginChild: ChildProcessWithoutNullStreams | undefined
  private threadId: string | undefined

  // app-server backend state
  private appServer: AppServerClient | undefined
  private appServerBroken = false
  private appServerCrashes = 0
  private currentTurn: { threadId: string; turnId: string | undefined } | undefined
  private threadSettings:
    | { model: string | undefined; sandbox: string; approvalPolicy: string }
    | undefined
  private startedThreads = new Set<string>()
  private resumedThreads = new Set<string>()
  private approvalSeq = 0
  private pendingApprovals = new Map<string, { client: AppServerClient; requestId: Json }>()
  private lastTurn:
    | { text: string; model: string | undefined; sandbox: string; webAccess: boolean }
    | undefined
  private agentCore: AgentCoreBackend | undefined

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Which engine the panel runs: agent-core (default) or codex app-server. */
  private engineChoice(): "app-server" | "agent-core" {
    return vscode.workspace.getConfiguration("unieai-code").get<string>("engine") === "app-server"
      ? "app-server"
      : "agent-core"
  }

  private ensureAgentCore(): AgentCoreBackend {
    if (!this.agentCore) {
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
      this.agentCore = new AgentCoreBackend(workspace, {
        post: (m) => this.post(m),
        requestApproval: (d) =>
          new Promise((resolve) => {
            const approvalId = `approval-${++this.approvalSeq}`
            this.agentCoreApprovals.set(approvalId, resolve)
            this.post({
              type: "approvalRequest",
              id: approvalId,
              kind: "command",
              detail: { command: d.detail, reason: `${d.tool}: ${d.action}` },
            })
          }),
        requestQuestion: (d) =>
          new Promise((resolve) => {
            const questionId = `question-${++this.approvalSeq}`
            this.agentCoreQuestions.set(questionId, resolve)
            this.post({ type: "questionRequest", id: questionId, question: d.question, options: d.options })
          }),
      })
    }
    return this.agentCore
  }
  private agentCoreApprovals = new Map<string, (d: Json) => void>()
  private agentCoreQuestions = new Map<string, (answer: string | null) => void>()

  /** Settle every pending agent-core approval/question prompt. Without this, a
   * new-chat/interrupt/panel-reset that removes the cards leaves the engine
   * awaiting a reply that can never arrive — a wedged turn. Decline/dismiss is
   * the safe default. */
  private settleAgentCorePrompts() {
    for (const [id, resolve] of this.agentCoreApprovals) {
      this.agentCoreApprovals.delete(id)
      resolve("decline")
    }
    for (const [id, resolve] of this.agentCoreQuestions) {
      this.agentCoreQuestions.delete(id)
      resolve(null)
    }
  }

  dispose() {
    this.appServer?.dispose()
    this.child?.kill("SIGTERM")
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined
      }
    })
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    }
    view.webview.html = this.html(view.webview)

    view.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case "ready":
          this.sendBootstrap()
          break
        case "send":
          this.runTurn(
            String(message.text ?? ""),
            message.model ? String(message.model) : undefined,
            message.sandbox ? String(message.sandbox) : undefined,
            Boolean(message.webAccess),
          )
          break
        case "setWebAccess":
          this.context.globalState.update("unieai-code.webAccess", Boolean(message.value))
          break
        case "stop":
          this.stopTurn()
          break
        case "steer": {
          // Mid-turn interjection: fold it into the running turn instead of
          // queuing a fresh turn. Only the in-process agent-core engine can
          // steer; the app-server path has no such seam, so report undelivered
          // and let the webview fall back.
          const text = String(message.text ?? "")
          const delivered =
            this.engineChoice() === "agent-core" && this.agentCore
              ? this.agentCore.steer(text)
              : false
          this.post({ type: "steerAck", id: message.id, delivered })
          break
        }
        case "approvalReply":
          this.resolveApproval(String(message.id), String(message.decision))
          break
        case "questionReply": {
          const resolve = this.agentCoreQuestions.get(String(message.id))
          if (resolve) {
            this.agentCoreQuestions.delete(String(message.id))
            resolve(message.answer == null ? null : String(message.answer))
          }
          break
        }
        case "userInputReply": {
          const entry = this.pendingApprovals.get(String(message.id))
          if (entry) {
            this.pendingApprovals.delete(String(message.id))
            entry.client.respond(entry.requestId, { answers: message.answers ?? [] })
          }
          break
        }
        case "retry":
          if (this.lastTurn) {
            const { text, model, sandbox, webAccess } = this.lastTurn
            this.runTurn(text, model, sandbox, webAccess)
          }
          break
        case "newChat":
          this.newChat()
          break
        case "login":
          this.runLogin(message.studioUrl ? String(message.studioUrl) : undefined)
          break
        case "logout":
          this.runLogout()
          break
        case "openTerminal":
          vscode.commands.executeCommand("unieai-code.openTerminal")
          break
        case "openSetting":
          vscode.commands.executeCommand("workbench.action.openSettings", String(message.key || "unieai-code"))
          break
        case "setModel":
          if (typeof message.model === "string") {
            this.context.globalState.update("unieai-code.model", message.model)
          }
          break
        case "cancelLogin":
          this.cancelLogin()
          break
        case "openUrl":
          if (typeof message.url === "string" && /^https?:\/\//.test(message.url)) {
            vscode.env.openExternal(vscode.Uri.parse(message.url))
          }
          break
        case "openStudioModels": {
          const url = String(message.url || "https://studio.unieai.com/models")
          vscode.env.openExternal(vscode.Uri.parse(url))
          break
        }
        case "copy": {
          const text = String(message.text ?? "")
          if (text) {
            vscode.env.clipboard.writeText(text).then(() => {
              this.post({ type: "copied", id: message.id })
            }, undefined)
          }
          break
        }
        case "openFile": {
          const rel = String(message.path || "")
          if (rel) {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri
            // Citations/tools may emit absolute paths — joinPath would mangle them.
            const target = path.isAbsolute(rel) || !root ? vscode.Uri.file(rel) : vscode.Uri.joinPath(root, rel)
            vscode.window.showTextDocument(target, { preview: true }).then(undefined, () => {
              vscode.window.showWarningMessage(`無法開啟 ${rel}`)
            })
          }
          break
        }
        case "listSessions":
          this.listSessions()
          break
        case "loadSession":
          this.loadSession(String(message.path || ""))
          break
      }
    })
  }

  newChat() {
    this.stopTurn()
    this.threadId = undefined
    this.threadSettings = undefined
    this.pendingApprovals.clear()
    this.settleAgentCorePrompts()
    if (this.engineChoice() === "agent-core") {
      this.agentCore?.newChat()
    }
    this.post({ type: "reset" })
    this.sendBootstrap()
  }

  insertText(text: string) {
    this.post({ type: "insert", text })
  }

  private sendBootstrap() {
    const { models, signedIn } = loadStoredModels()
    this.post({
      type: "bootstrap",
      models,
      signedIn,
      threadId: this.threadId ?? null,
      currentModel: this.context.globalState.get<string>("unieai-code.model") ?? null,
      webAccess: this.context.globalState.get<boolean>("unieai-code.webAccess") ?? false,
    })
  }

  /** Runs `unieai login [--studio-url]`, relaying the device-code prompt. */
  private runLogin(studioUrl: string | undefined) {
    if (this.loginChild) {
      return
    }
    const args = ["login"]
    if (studioUrl) {
      args.push("--studio-url", studioUrl)
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(executablePath(), args, { env: { ...process.env, UNIEAI_CALLER: "vscode" } })
    } catch (err) {
      this.post({ type: "loginError", message: String(err) })
      return
    }
    this.loginChild = child

    let buffered = ""
    let prompted = false
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      buffered += chunk
      if (!prompted) {
        const url = buffered.match(/https?:\/\/\S+\/auth\/device\/authorize\/\S+/)?.[0]
        const code = buffered.match(/Code:\s*(\S+)/)?.[1]
        if (url && code) {
          prompted = true
          this.post({ type: "loginPrompt", url, code })
          vscode.env.openExternal(vscode.Uri.parse(url))
        }
      }
    })
    child.once("error", (err) => {
      this.loginChild = undefined
      this.post({
        type: "loginError",
        message: `Failed to start \`${executablePath()}\`: ${err.message}. Set unieai-code.executablePath.`,
      })
    })
    child.once("exit", (code) => {
      this.loginChild = undefined
      if (code === 0) {
        this.post({ type: "loginDone" })
        this.sendBootstrap()
      } else if (code !== null) {
        const tail = buffered.trim().split("\n").slice(-3).join("\n")
        this.post({ type: "loginError", message: tail || `login exited with code ${code}` })
      }
    })
  }

  private cancelLogin() {
    if (this.loginChild) {
      this.loginChild.kill("SIGTERM")
      this.loginChild = undefined
    }
  }

  /** Runs `unieai logout` (revokes the Studio session, deletes unieai.json). */
  private runLogout() {
    this.stopTurn()
    this.appServer?.dispose()
    this.appServer = undefined
    this.threadId = undefined
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(executablePath(), ["logout"], {
        env: { ...process.env, UNIEAI_CALLER: "vscode" },
      })
    } catch (err) {
      this.post({ type: "fatal", message: `Logout failed: ${String(err)}` })
      return
    }
    child.once("exit", () => {
      this.post({ type: "reset" })
      this.sendBootstrap()
    })
    child.once("error", (err) => {
      this.post({ type: "fatal", message: `Logout failed: ${err.message}` })
    })
  }

  private sessionsDir(): string {
    return path.join(unieaiHome(), "sessions")
  }

  private agentSessionsDir(): string {
    return path.join(unieaiHome(), "agent-sessions")
  }

  /** Lists recorded sessions (rollout-*.jsonl), newest first. */
  private listSessions() {
    if (this.engineChoice() === "agent-core") {
      this.listAgentCoreSessions()
      return
    }
    const root = this.sessionsDir()
    const files: { file: string; mtime: number }[] = []
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && depth < 4) {
          walk(full, depth + 1)
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          try {
            files.push({ file: full, mtime: fs.statSync(full).mtimeMs })
          } catch {
            /* ignore */
          }
        }
      }
    }
    walk(root, 0)
    files.sort((a, b) => b.mtime - a.mtime)

    const sessions = []
    for (const { file, mtime } of files.slice(0, 30)) {
      const parsed = this.parseSessionHead(file)
      if (parsed) {
        sessions.push({ ...parsed, path: file, mtime })
      }
    }
    this.post({ type: "sessions", sessions })
  }

  private parseSessionHead(
    file: string,
  ): { id: string; preview: string; cwd: string } | undefined {
    let head: string
    try {
      const fd = fs.openSync(file, "r")
      const buffer = Buffer.alloc(65536)
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
      fs.closeSync(fd)
      head = buffer.toString("utf8", 0, read)
    } catch {
      return undefined
    }
    let id = ""
    let cwd = ""
    let preview = ""
    for (const line of head.split("\n")) {
      let parsed: { type?: string; payload?: Record<string, unknown> }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const payload = parsed.payload ?? {}
      if (parsed.type === "session_meta") {
        id = String(payload["id"] ?? "")
        cwd = String(payload["cwd"] ?? "")
      } else if (
        parsed.type === "event_msg" &&
        payload["type"] === "user_message" &&
        !preview
      ) {
        preview = String(payload["message"] ?? "").slice(0, 120)
      }
      if (id && preview) {
        break
      }
    }
    if (!id) {
      return undefined
    }
    return { id, preview: preview || "(no prompt)", cwd }
  }

  /** Lists agent-core sessions ($UNIEAI_HOME/agent-sessions/*.json). */
  private listAgentCoreSessions() {
    const dir = this.agentSessionsDir()
    const sessions: Json[] = []
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
    } catch {
      names = []
    }
    for (const name of names) {
      try {
        const full = path.join(dir, name)
        const parsed = JSON.parse(fs.readFileSync(full, "utf8"))
        const firstUser = (parsed.messages ?? []).find((m: Json) => m.role === "user")
        const id = parsed.id ?? name.replace(/\.json$/, "")
        sessions.push({
          id,
          path: id, // agent-core resumes by id, not filesystem path
          preview: String(firstUser?.content ?? "(empty)").slice(0, 120),
          cwd: parsed.cwd ?? "",
          mtime: fs.statSync(full).mtimeMs,
        })
      } catch {
        /* skip */
      }
    }
    sessions.sort((a, b) => b.mtime - a.mtime)
    this.post({ type: "sessions", sessions: sessions.slice(0, 30) })
  }

  /** Resumes an agent-core session: replay its messages, point the engine at it. */
  private loadAgentCoreSession(sessionId: string) {
    const safe = sessionId.replace(/[^\w.-]/g, "")
    let parsed: Json
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(this.agentSessionsDir(), `${safe}.json`), "utf8"))
    } catch (err) {
      this.post({ type: "fatal", message: `無法讀取 session: ${String(err)}` })
      return
    }
    const items: { role: string; text: string }[] = []
    for (const m of parsed.messages ?? []) {
      if (m.role === "user" || m.role === "assistant") {
        const text = typeof m.content === "string" ? m.content.trim() : ""
        if (text) items.push({ role: m.role === "user" ? "user" : "agent", text })
      }
    }
    // Stop any in-flight turn (and settle its prompts) before swapping the
    // session, so the old engine can't keep streaming into the new transcript.
    this.stopTurn()
    this.ensureAgentCore().resume(safe)
    this.post({ type: "sessionLoaded", items })
  }

  /** Loads a session transcript and switches the thread to it. */
  private loadSession(file: string) {
    if (this.engineChoice() === "agent-core") {
      this.loadAgentCoreSession(String(file))
      return
    }
    const resolved = path.resolve(file)
    if (!resolved.startsWith(path.resolve(this.sessionsDir()) + path.sep)) {
      return
    }
    let raw: string
    try {
      raw = fs.readFileSync(resolved, "utf8")
    } catch (err) {
      this.post({ type: "fatal", message: `Failed to read session: ${String(err)}` })
      return
    }
    this.stopTurn()
    let threadId = ""
    const items: { role: string; text: string }[] = []
    for (const line of raw.split("\n")) {
      let parsed: { type?: string; payload?: Record<string, unknown> }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const payload = parsed.payload ?? {}
      if (parsed.type === "session_meta") {
        threadId = String(payload["id"] ?? "")
      } else if (parsed.type === "event_msg") {
        const kind = payload["type"]
        if (kind === "user_message" || kind === "agent_message") {
          const text = String(payload["message"] ?? "").trim()
          if (text) {
            items.push({ role: kind === "user_message" ? "user" : "agent", text })
          }
        }
      } else if (parsed.type === "response_item" && payload["type"] === "function_call") {
        // Keep tool calls visible when a session is reloaded.
        const name = String(payload["name"] ?? "tool")
        let summary = `工具 ${name}`
        try {
          const args = JSON.parse(String(payload["arguments"] ?? "{}")) as {
            command?: string | string[]
          }
          if (Array.isArray(args.command)) {
            summary = `$ ${args.command.join(" ")}`
          } else if (typeof args.command === "string") {
            summary = `$ ${args.command}`
          }
        } catch {
          /* keep generic summary */
        }
        items.push({ role: "tool", text: summary })
      }
    }
    if (!threadId) {
      this.post({ type: "fatal", message: "Could not read a thread id from this session." })
      return
    }
    this.threadId = threadId
    this.post({ type: "sessionLoaded", items })
  }

  private post(message: unknown) {
    // A disposed webview throws on postMessage; stream callbacks (child stdout,
    // engine events) can fire after disposal, so swallow rather than crash the
    // extension host.
    try {
      this.view?.webview.postMessage(message)
    } catch {
      /* view disposed mid-stream */
    }
  }

  private stopTurn() {
    if (this.engineChoice() === "agent-core" && this.agentCore) {
      // Unblock a turn parked on an approval/question card before aborting —
      // the loop only observes the abort signal between steps, so a pending
      // prompt would otherwise keep the turn wedged forever.
      this.settleAgentCorePrompts()
      this.agentCore.interrupt()
      return
    }
    if (this.appServer?.alive && this.currentTurn) {
      const { threadId, turnId } = this.currentTurn
      this.appServer.request("turn/interrupt", { threadId, turnId }).catch(() => {})
      this.currentTurn = undefined
      this.post({ type: "turnState", state: "interrupted" })
      this.post({ type: "running", value: false })
      return
    }
    if (this.child) {
      this.child.kill("SIGTERM")
      this.child = undefined
      this.post({ type: "turnState", state: "interrupted" })
      this.post({ type: "running", value: false })
    }
  }

  // ── app-server backend ────────────────────────────────────────────────

  /** Returns a live initialized client, or null → use the exec fallback. */
  private async ensureAppServer(): Promise<AppServerClient | null> {
    if (this.appServerBroken) {
      return null
    }
    if (this.appServer?.alive) {
      return this.appServer
    }
    const client = new AppServerClient(executablePath(), {
      ...process.env,
      UNIEAI_CALLER: "vscode",
    })
    client.onNotification = (method, params) => this.handleNotification(method, params)
    client.onServerRequest = (method, params, requestId) =>
      this.handleServerRequest(client, method, params, requestId)
    client.onExit = () => {
      this.appServer = undefined
      this.appServerCrashes += 1
      if (this.currentTurn) {
        this.currentTurn = undefined
        this.post({ type: "turnState", state: "failed", retryable: true })
        this.post({ type: "running", value: false })
      }
      if (this.appServerCrashes >= 3) {
        this.markAppServerBroken()
      }
    }
    try {
      await client.start()
      await client.request("initialize", {
        clientInfo: { name: "unieai-code-vscode", title: "UnieAI Code", version: "0.9.0" },
        capabilities: { experimentalApi: true },
      })
    } catch {
      client.dispose()
      this.markAppServerBroken()
      return null
    }
    this.appServer = client
    this.resumedThreads.clear()
    return client
  }

  private markAppServerBroken() {
    if (!this.appServerBroken) {
      this.appServerBroken = true
      this.post({
        type: "stderr",
        text: "進階模式無法啟動，已降級為基本模式（無互動核准與逐字串流）",
      })
    }
  }

  private handleNotification(method: string, params: Json) {
    switch (method) {
      case "item/started":
      case "item/completed": {
        const item = this.mapV2Item(params?.item)
        if (item) {
          this.post({ type: "itemUpsert", item, done: method === "item/completed" })
        }
        break
      }
      case "item/agentMessage/delta":
        this.post({ type: "turnDelta", kind: "agent", itemKey: params.itemId, text: params.delta })
        break
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        this.post({
          type: "turnDelta",
          kind: "reasoning",
          itemKey: params.itemId,
          text: params.delta,
        })
        break
      case "item/commandExecution/outputDelta":
        this.post({
          type: "turnDelta",
          kind: "cmdOutput",
          itemKey: params.itemId,
          text: typeof params.delta === "string" ? params.delta : "",
        })
        break
      case "item/plan/delta":
        this.post({ type: "turnDelta", kind: "plan", itemKey: params.itemId, text: params.delta })
        break
      case "item/fileChange/patchUpdated":
        // Live diff while apply_patch runs: re-upsert with the updated changes.
        this.post({
          type: "itemUpsert",
          item: {
            id: params.itemId,
            type: "file_change",
            changes: (params.changes ?? []).map((c: Json) => ({
              path: c.path,
              kind: c.kind,
              diff: typeof c.diff === "string" ? c.diff : "",
            })),
            status: "in_progress",
          },
          done: false,
        })
        break
      case "item/mcpToolCall/progress":
        this.post({
          type: "turnDelta",
          kind: "cmdOutput",
          itemKey: params.itemId,
          text: typeof params.message === "string" ? params.message + "\n" : "",
        })
        break
      case "thread/tokenUsage/updated": {
        const total = params?.tokenUsage?.total?.totalTokens
        if (typeof total === "number") {
          this.post({ type: "tokenUsage", total })
        }
        break
      }
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        const item = this.mapV2Item({ ...params, type: "autoApprovalReview", id: params?.itemId })
        if (item) this.post({ type: "itemUpsert", item, done: method.endsWith("completed") })
        break
      }
      case "item/commandExecution/terminalInteraction":
        if (typeof params?.stdin === "string" && params.stdin) {
          this.post({ type: "turnDelta", kind: "cmdOutput", itemKey: params.itemId, text: params.stdin })
        }
        break
      case "turn/completed": {
        const status = params?.turn?.status
        this.currentTurn = undefined
        if (status === "failed") {
          this.post({ type: "turnState", state: "failed", retryable: true })
        } else if (status === "interrupted") {
          this.post({ type: "turnState", state: "interrupted" })
        } else {
          this.post({ type: "turnState", state: "idle" })
        }
        this.post({ type: "running", value: false })
        break
      }
      case "error":
        if (params?.message) {
          this.post({ type: "stderr", text: String(params.message) })
        }
        break
      default:
        break
    }
  }

  /** Map a v2 camelCase thread item onto the webview's item shape. */
  private mapV2Item(item: Json): Json | null {
    if (!item || typeof item !== "object") {
      return null
    }
    switch (item.type) {
      case "agentMessage": {
        // Surface memory citations as footnote links under the message.
        const entries = item.memoryCitation?.entries ?? []
        const citations = entries.map((e: Json) => ({
          path: e.path ?? "",
          lineStart: e.lineStart,
          lineEnd: e.lineEnd,
          note: e.note ?? "",
        }))
        return { id: item.id, type: "agent_message", text: item.text ?? "", citations }
      }
      case "reasoning": {
        // v2 reasoning carries `summary: string[]` and/or `content: string[]`,
        // not `text` — joining avoids rendering "[object Array]".
        const join = (v: Json) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "")
        return {
          id: item.id,
          type: "reasoning",
          text: join(item.text) || join(item.summary) || join(item.content),
        }
      }
      case "commandExecution":
        return {
          id: item.id,
          type: "command_execution",
          command: item.command ?? "",
          aggregated_output: item.aggregatedOutput ?? "",
          exit_code: item.exitCode ?? undefined,
          status:
            item.status === "failed"
              ? "failed"
              : item.status === "completed"
                ? "completed"
                : "in_progress",
        }
      case "fileChange":
        return {
          id: item.id,
          type: "file_change",
          changes: (item.changes ?? []).map((c: Json) => ({
            path: c.path,
            kind: c.kind,
            diff: typeof c.diff === "string" ? c.diff : "",
          })),
          status: item.status === "failed" ? "failed" : "completed",
        }
      case "plan":
        // v2 Plan carries a markdown checklist string in `text`.
        return { id: item.id, type: "plan", text: item.text ?? "" }
      case "todoList":
        return {
          id: item.id,
          type: "todo_list",
          items: (item.items ?? item.steps ?? []).map((t: Json) => ({
            text: t.text ?? t.step ?? String(t),
            completed: Boolean(t.completed),
          })),
        }
      case "subAgentActivity":
        return {
          id: item.id,
          type: "subagent",
          kind: item.kind ?? "",
          agentThreadId: item.agentThreadId ?? "",
          agentPath: item.agentPath ?? "",
        }
      case "webSearch":
        return { id: item.id, type: "web_search", query: item.query ?? "" }
      case "mcpToolCall":
        return {
          id: item.id,
          type: "mcp_tool_call",
          server: item.server,
          tool: item.tool,
          status: item.status,
          arguments: item.arguments ?? null,
        }
      case "collabAgentToolCall":
        return {
          id: item.id,
          type: "collab_agent",
          tool: item.tool ?? "",
          status: item.status ?? "",
          model: item.model ?? "",
          agents: Object.entries(item.agentsStates ?? {}).map(([tid, st]: [string, Json]) => ({
            threadId: tid,
            status: st?.status ?? "",
            message: st?.message ?? "",
          })),
        }
      case "dynamicToolCall":
        return {
          id: item.id,
          type: "dynamic_tool",
          namespace: item.namespace ?? "",
          tool: item.tool ?? "",
          arguments: item.arguments ?? null,
          success: item.success,
        }
      case "autoApprovalReview":
        return {
          id: item.id,
          type: "auto_review",
          action: item.action ?? "",
          riskLevel: item.review?.riskLevel ?? "",
          rationale: item.review?.rationale ?? "",
          status: item.review?.status ?? "",
        }
      case "imageGeneration":
        return {
          id: item.id,
          type: "image_generation",
          status: item.status,
          savedPath: item.savedPath ?? "",
          revisedPrompt: item.revisedPrompt ?? "",
        }
      case "imageView":
        return { id: item.id, type: "image_view", path: item.path ?? "" }
      case "contextCompaction":
        return { id: item.id, type: "context_compaction" }
      case "enteredReviewMode":
        return { id: item.id, type: "review_mode", entered: true, review: item.review ?? "" }
      case "exitedReviewMode":
        return { id: item.id, type: "review_mode", entered: false, review: item.review ?? "" }
      case "sleep":
        return { id: item.id, type: "sleep", durationMs: item.durationMs ?? null }
      case "hookPrompt":
        return {
          id: item.id,
          type: "hook_prompt",
          text: (item.fragments ?? []).map((f: Json) => f.text ?? "").join(""),
        }
      case "error":
        return { id: item.id, type: "error", message: item.message ?? "error" }
      case "userMessage":
        return null // already echoed locally
      default:
        return null
    }
  }

  private handleServerRequest(
    client: AppServerClient,
    method: string,
    params: Json,
    requestId: Json,
  ) {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      const approvalId = `approval-${++this.approvalSeq}`
      this.pendingApprovals.set(approvalId, { client, requestId })
      const kind = method.includes("commandExecution")
        ? "command"
        : method.includes("fileChange")
          ? "fileChange"
          : "permissions"
      const detail =
        kind === "command"
          ? { command: params?.command ?? "", cwd: params?.cwd ?? "", reason: params?.reason ?? "" }
          : kind === "fileChange"
            ? {
                reason: params?.reason ?? "",
                files: (params?.changes ?? []).map((c: Json) => ({
                  path: c.path,
                  kind: c.kind,
                  diff: typeof c.diff === "string" ? c.diff : "",
                })),
              }
            : { reason: params?.reason ?? "" }
      this.post({ type: "approvalRequest", id: approvalId, kind, itemKey: params?.itemId, detail })
      // If the panel is hidden, surface an actionable OS-level prompt too.
      if (!this.view?.visible) {
        const label = kind === "command" ? "指令執行" : "檔案修改"
        vscode.window
          .showInformationMessage(`UnieAI Code 請求核准：${label}`, "允許", "拒絕")
          .then((choice) => {
            if (choice && this.pendingApprovals.has(approvalId)) {
              this.resolveApproval(approvalId, choice === "允許" ? "accept" : "decline")
              this.post({ type: "approvalResolved", id: approvalId, decision: choice })
            }
          })
      }
      return
    }
    if (method === "item/tool/requestUserInput") {
      // The agent is asking the user a question mid-turn — render a card and
      // reply with { answers }, instead of silently returning an empty answer.
      const inputId = `userinput-${++this.approvalSeq}`
      this.pendingApprovals.set(inputId, { client, requestId })
      this.post({
        type: "userInputRequest",
        id: inputId,
        questions: (params?.questions ?? []).map((q: Json) => ({
          header: q.header ?? "",
          question: q.question ?? "",
          options: (q.options ?? []).map((o: Json) => (typeof o === "string" ? o : o.label ?? "")),
          isSecret: Boolean(q.isSecret),
        })),
      })
      return
    }
    // Unknown server request: decline politely so the turn can proceed.
    client.respond(requestId, {})
  }

  private resolveApproval(approvalId: string, decision: string) {
    // agent-core approvals resolve a pending promise instead of an RPC reply.
    const acResolve = this.agentCoreApprovals.get(approvalId)
    if (acResolve) {
      this.agentCoreApprovals.delete(approvalId)
      acResolve(decision)
      return
    }
    const entry = this.pendingApprovals.get(approvalId)
    if (!entry) {
      return
    }
    this.pendingApprovals.delete(approvalId)
    entry.client.respond(entry.requestId, { decision })
  }

  private async runTurn(
    text: string,
    model: string | undefined,
    sandboxOverride: string | undefined,
    webAccess: boolean,
  ) {
    const prompt = text.trim()
    if (!prompt) {
      return
    }
    // Defensive: a dead server can't own a turn.
    if (this.currentTurn && !this.appServer?.alive) {
      this.currentTurn = undefined
    }
    if (this.child || this.currentTurn) {
      this.post({ type: "stderr", text: "上一回合仍在進行中——先按停止或稍候" })
      return
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const allowedSandboxes = ["read-only", "workspace-write", "danger-full-access"]
    const sandbox =
      (sandboxOverride && allowedSandboxes.includes(sandboxOverride) ? sandboxOverride : null) ||
      vscode.workspace.getConfiguration("unieai-code").get<string>("sandboxMode") ||
      "workspace-write"
    this.lastTurn = { text: prompt, model, sandbox, webAccess }

    if (this.engineChoice() === "agent-core") {
      // agent-core runs in-process and resolves the sandbox binary from
      // UNIEAI_BIN / PATH. A Dock-launched extension host often lacks the CLI on
      // PATH (e.g. an nvm-managed install), so hand it the configured path here —
      // otherwise every sandboxed bash call dies with ENOENT and no files change.
      process.env.UNIEAI_BIN = executablePath()
      try {
        await this.ensureAgentCore().send(prompt, model, webAccess)
      } catch (err) {
        this.post({ type: "stderr", text: `agent-core 失敗：${String(err)}` })
        this.post({ type: "running", value: false })
      }
      return
    }

    const client = await this.ensureAppServer()
    if (client) {
      try {
        await this.runTurnAppServer(client, prompt, model, sandbox, webAccess, workspaceFolder)
        return
      } catch (err) {
        this.post({ type: "stderr", text: `進階模式失敗，改用基本模式：${String(err)}` })
      }
    }
    this.runTurnExec(prompt, model, sandbox, webAccess, workspaceFolder)
  }

  private async runTurnAppServer(
    client: AppServerClient,
    prompt: string,
    model: string | undefined,
    sandbox: string,
    webAccess: boolean,
    workspaceFolder: string | undefined,
  ) {
    // 預設權限 = ask before commands/edits; 唯讀/完全存取 = never ask.
    const approvalPolicy = sandbox === "workspace-write" ? "on-request" : "never"
    const config = webAccess ? { "sandbox_workspace_write.network_access": true } : undefined

    if (this.threadId && !this.startedThreads.has(this.threadId)) {
      // A thread from history (or a previous server instance) must be resumed.
      await client.request("thread/resume", { threadId: this.threadId })
      this.startedThreads.add(this.threadId)
      this.resumedThreads.add(this.threadId)
    }

    if (!this.threadId) {
      const started = await client.request("thread/start", {
        model,
        cwd: workspaceFolder,
        approvalPolicy,
        sandbox,
        config,
      })
      this.threadId = started?.thread?.id
      if (!this.threadId) {
        throw new Error("thread/start returned no id")
      }
      this.startedThreads.add(this.threadId)
      this.threadSettings = { model, sandbox, approvalPolicy }
    } else if (
      this.threadSettings &&
      (this.threadSettings.sandbox !== sandbox ||
        this.threadSettings.approvalPolicy !== approvalPolicy)
    ) {
      await client
        .request("thread/settings/update", {
          threadId: this.threadId,
          approvalPolicy,
          sandbox,
        })
        .catch(() => {})
      this.threadSettings = { model, sandbox, approvalPolicy }
    }

    this.post({ type: "running", value: true })
    // Claim the turn BEFORE awaiting: a fast turn can complete (clearing
    // currentTurn via the turn/completed notification) before the turn/start
    // response arrives — writing the id afterwards would leave a stale claim
    // that blocks every subsequent send.
    const claim = { threadId: this.threadId!, turnId: undefined as string | undefined }
    this.currentTurn = claim
    try {
      const turn = await client.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt }],
        ...(model ? { model } : {}),
      })
      if (this.currentTurn === claim) {
        claim.turnId = turn?.turn?.id
      }
    } catch (err) {
      if (this.currentTurn === claim) {
        this.currentTurn = undefined
      }
      throw err
    }
  }

  private runTurnExec(
    prompt: string,
    model: string | undefined,
    sandbox: string,
    webAccess: boolean,
    workspaceFolder: string | undefined,
  ) {

    const args = ["exec", "--experimental-json", "--sandbox", sandbox, "--skip-git-repo-check"]
    if (webAccess) {
      // Lets the agent curl/fetch from inside the workspace-write sandbox.
      args.push("--config", "sandbox_workspace_write.network_access=true")
    }
    if (model) {
      args.push("--model", model)
    }
    if (workspaceFolder) {
      args.push("--cd", workspaceFolder)
    }
    if (this.threadId) {
      args.push("resume", this.threadId)
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(executablePath(), args, {
        env: { ...process.env, UNIEAI_CALLER: "vscode" },
      })
    } catch (err) {
      this.post({ type: "fatal", message: `Failed to start unieai: ${String(err)}` })
      return
    }
    this.child = child
    this.post({ type: "running", value: true })

    child.once("error", (err) => {
      this.post({
        type: "fatal",
        message: `Failed to start \`${executablePath()}\`: ${err.message}. Install the CLI or set unieai-code.executablePath.`,
      })
      this.child = undefined
      this.post({ type: "running", value: false })
    })

    // Spawn failures (ENOENT) surface asynchronously; the pending stdin write
    // then errors (EPIPE), which is fatal without a listener. The 'error'
    // handler above already reports the underlying failure to the user.
    child.stdin.on("error", () => {})
    child.stdin.write(prompt)
    child.stdin.end()

    let buffered = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk
      let newline = buffered.indexOf("\n")
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf("\n")
        if (!line) {
          continue
        }
        try {
          const event = JSON.parse(line)
          if (event?.type === "thread.started" && typeof event.thread_id === "string") {
            this.threadId = event.thread_id
          }
          this.post({ type: "event", event })
        } catch {
          // Non-JSON output (warnings etc.) — surface as plain text.
          this.post({ type: "stderr", text: line })
        }
      }
    })

    const stderrChunks: string[] = []
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk)
    })

    child.once("exit", (code) => {
      if (this.child === child) {
        this.child = undefined
      }
      this.post({ type: "running", value: false })
      if (code !== 0 && code !== null) {
        const stderr = stderrChunks.join("").trim()
        if (stderr) {
          this.post({ type: "stderr", text: stderr.split("\n").slice(-8).join("\n") })
        }
      }
    })
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.js"),
    )
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.css"),
    )
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "logo.png"),
    )
    const nonce = Math.random().toString(36).slice(2)
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>UnieAI Code</title>
</head>
<body>
  <!-- Sign-in view -->
  <section id="login-view" hidden>
    <div id="login-card">
      <img id="login-logo" src="${logoUri}" alt="UnieAI">
      <h1>歡迎使用 UnieAI Code</h1>
      <p class="subtitle">登入您的帳戶</p>
      <button id="login-unieai" class="login-option">使用 UnieAI Studio 登入</button>
      <div class="divider"><span>或</span></div>
      <input id="company-url" type="text" placeholder="公司 Studio 網址（例如 studio.demo.unieai.com）">
      <button id="login-company" class="login-option">使用 Company UnieAI Studio 登入</button>
      <div id="login-pending" hidden>
        <p class="subtitle">請在瀏覽器中確認登入代碼</p>
        <div id="login-code"></div>
        <a id="login-link"></a>
        <button id="login-cancel" class="link-button">取消</button>
      </div>
      <p id="login-error" class="error-text" hidden></p>
    </div>
  </section>

  <!-- Chat view -->
  <section id="chat-view" hidden>
    <div id="toolbar">
      <span id="token-meter" class="meter"></span>
      <button id="history-btn" class="ghost" title="歷史 session">歷史</button>
      <button id="new-chat-btn" class="ghost" title="開新對話">新對話</button>
      <button id="logout-btn" class="ghost" title="登出 UnieAI Studio">登出</button>
    </div>
    <main id="messages" aria-live="polite"></main>
    <div id="history-overlay" hidden>
      <div id="history-panel">
        <div id="history-header">
          <span>歷史 session</span>
          <button id="history-close" class="ghost">✕</button>
        </div>
        <div id="history-list"></div>
      </div>
    </div>
    <footer id="composer">
      <div id="slash-menu" hidden></div>
      <div id="composer-box">
        <div id="input-row">
          <span id="prompt-char">›</span>
          <textarea id="input" rows="2" placeholder="詢問 UnieAI Code 任何事"></textarea>
        </div>
        <div id="composer-row">
          <div class="composer-left">
            <select id="mode" class="pill" title="模式">
              <option value="exec">執行</option>
              <option value="plan">規劃</option>
            </select>
            <select id="perm" class="pill" title="權限">
              <option value="workspace-write">預設權限</option>
              <option value="read-only">唯讀</option>
              <option value="danger-full-access">完全存取</option>
            </select>
            <select id="web" class="pill" title="允許 agent 連網（唯讀模式下無效）">
              <option value="off">上網 關</option>
              <option value="on">上網 開</option>
            </select>
          </div>
          <div class="composer-right">
            <select id="model" class="pill model-pill" title="模型"></select>
            <button id="stop" class="send-btn stop-btn" title="停止目前回合" hidden>■</button>
            <button id="send" class="send-btn" title="送出 (Enter)">↑</button>
          </div>
        </div>
      </div>
      <div id="composer-hint">Enter 送出 · Shift+Enter 換行 · / 指令</div>
    </footer>
  </section>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

export function deactivate() {}
