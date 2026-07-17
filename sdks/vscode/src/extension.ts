import { ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"

const TERMINAL_NAME = "unieai"

/** Model entry stored by `unieai login` in $UNIEAI_HOME/unieai.json. */
type StoredModel = { id: string; name?: string }

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatViewProvider(context)

  context.subscriptions.push(
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
  return vscode.workspace.getConfiguration("unieai-code").get<string>("executablePath") || "unieai"
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

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
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
          )
          break
        case "stop":
          this.stopTurn()
          break
        case "newChat":
          this.newChat()
          break
        case "login":
          this.runLogin(message.studioUrl ? String(message.studioUrl) : undefined)
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

  private sessionsDir(): string {
    return path.join(unieaiHome(), "sessions")
  }

  /** Lists recorded sessions (rollout-*.jsonl), newest first. */
  private listSessions() {
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

  /** Loads a session transcript and switches the thread to it. */
  private loadSession(file: string) {
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
    this.view?.webview.postMessage(message)
  }

  private stopTurn() {
    if (this.child) {
      this.child.kill("SIGTERM")
      this.child = undefined
      this.post({ type: "running", value: false })
    }
  }

  private runTurn(text: string, model: string | undefined, sandboxOverride: string | undefined) {
    const prompt = text.trim()
    if (!prompt || this.child) {
      return
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const allowedSandboxes = ["read-only", "workspace-write", "danger-full-access"]
    const sandbox =
      (sandboxOverride && allowedSandboxes.includes(sandboxOverride) ? sandboxOverride : null) ||
      vscode.workspace.getConfiguration("unieai-code").get<string>("sandboxMode") ||
      "workspace-write"

    const args = ["exec", "--experimental-json", "--sandbox", sandbox, "--skip-git-repo-check"]
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
      <button id="history-btn" class="ghost" title="歷史 session">歷史</button>
      <button id="new-chat-btn" class="ghost" title="開新對話">新對話</button>
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
      <div id="composer-box">
        <textarea id="input" rows="2" placeholder="詢問 UnieAI Code 任何事"></textarea>
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
          </div>
          <div class="composer-right">
            <select id="model" class="pill model-pill" title="模型"></select>
            <button id="send" class="send-btn" title="送出 (Enter)">↑</button>
          </div>
        </div>
      </div>
    </footer>
  </section>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

export function deactivate() {}
