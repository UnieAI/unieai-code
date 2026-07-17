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
          this.runTurn(String(message.text ?? ""), message.model ? String(message.model) : undefined)
          break
        case "stop":
          this.stopTurn()
          break
        case "newChat":
          this.newChat()
          break
        case "openStudioModels": {
          const url = String(message.url || "https://studio.unieai.com/models")
          vscode.env.openExternal(vscode.Uri.parse(url))
          break
        }
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

  private runTurn(text: string, model: string | undefined) {
    const prompt = text.trim()
    if (!prompt || this.child) {
      return
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const sandbox =
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
    const nonce = Math.random().toString(36).slice(2)
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>UnieAI Code</title>
</head>
<body>
  <main id="messages" aria-live="polite"></main>
  <footer id="composer">
    <div id="status-row">
      <select id="model" title="Model"></select>
      <button id="stop" hidden title="Stop the current turn">Stop</button>
    </div>
    <div id="input-row">
      <textarea id="input" rows="3" placeholder="Ask UnieAI Code to do anything"></textarea>
      <button id="send" title="Send (Enter)">Send</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

export function deactivate() {}
