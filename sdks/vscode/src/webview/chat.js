// UnieAI Code chat panel webview. TUI-flat transcript: "›" user lines,
// markdown-rendered agent prose, "•" tool lines with expandable output,
// collapsed reasoning (both reasoning items and inline <think> blocks).
import { marked } from "marked"

const vscode = acquireVsCodeApi()

const $ = (id) => document.getElementById(id)
const loginView = $("login-view")
const chatView = $("chat-view")
const messagesEl = $("messages")
const inputEl = $("input")
const sendEl = $("send")
const modelEl = $("model")
const modeEl = $("mode")
const permEl = $("perm")
const webEl = $("web")
const historyOverlay = $("history-overlay")
const historyList = $("history-list")

marked.setOptions({ breaks: true, gfm: true })

/** turn-scoped item key -> element (exec reuses item ids every turn) */
const itemEls = new Map()
let turnSeq = 0
let workingEl = null
let workingTimer = null
let workingStart = 0
let running = false
let studioModelsUrl = "https://studio.unieai.com/models"

// ---------- helpers ----------

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight
}

/** Markdown -> sanitized DOM nodes. CSP already blocks script execution;
 * this additionally strips embed-style tags, on* handlers, and js: URLs. */
function renderMarkdown(text) {
  const template = document.createElement("template")
  template.innerHTML = marked.parse(text)
  const walker = template.content.querySelectorAll("*")
  for (const el of walker) {
    if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM"].includes(el.tagName)) {
      el.remove()
      continue
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name)
      }
      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name)
      }
    }
    if (el.tagName === "A") {
      const href = el.getAttribute("href") || ""
      el.addEventListener("click", (e) => {
        e.preventDefault()
        if (/^https?:\/\//.test(href)) {
          vscode.postMessage({ type: "openUrl", url: href })
        }
      })
    }
  }
  const container = document.createElement("div")
  container.className = "md"
  container.appendChild(template.content)
  return container
}

/** Splits agent text into prose / thinking segments. Gateway models emit
 * either reasoning items or inline <think>...</think> (possibly unclosed
 * while streaming). */
function splitThinking(text) {
  const segments = []
  let rest = text

  // Some gateways strip the opening tag: "reasoning...</think>answer".
  const firstClose = rest.indexOf("</think>")
  const firstOpen = rest.indexOf("<think>")
  if (firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen)) {
    segments.push({ think: true, text: rest.slice(0, firstClose) })
    rest = rest.slice(firstClose + 8)
  }

  while (rest.length) {
    const open = rest.indexOf("<think>")
    if (open === -1) {
      segments.push({ think: false, text: rest })
      break
    }
    if (open > 0) {
      segments.push({ think: false, text: rest.slice(0, open) })
    }
    const close = rest.indexOf("</think>", open)
    if (close === -1) {
      segments.push({ think: true, text: rest.slice(open + 7) })
      break
    }
    segments.push({ think: true, text: rest.slice(open + 7, close) })
    rest = rest.slice(close + 8)
  }
  return segments.filter((s) => s.text.trim())
}

function reasoningBlock(text, open = false) {
  const details = document.createElement("details")
  details.className = "reasoning"
  if (open) {
    details.open = true
  }
  const summary = document.createElement("summary")
  summary.textContent = "思考過程"
  const body = document.createElement("div")
  body.className = "reasoning-body"
  body.textContent = text.trim()
  details.append(summary, body)
  return details
}

// ---------- transcript lines ----------

function appendLine(el) {
  messagesEl.appendChild(el)
  pinWorking()
  scrollToBottom()
  return el
}

function userLine(text) {
  const el = document.createElement("div")
  el.className = "line user"
  el.textContent = text
  return appendLine(el)
}

function metaLine(text) {
  const el = document.createElement("div")
  el.className = "line meta"
  el.textContent = text
  return appendLine(el)
}

function errorLine(text) {
  const el = document.createElement("div")
  el.className = "line error"
  el.textContent = text
  return appendLine(el)
}

function agentBlock(text) {
  const el = document.createElement("div")
  el.className = "line agent"
  const segments = splitThinking(text)
  // A model may wrap its entire reply in an (unclosed) <think> block; keep it
  // visible by auto-opening when there is no prose left at all.
  const hasProse = segments.some((s) => !s.think)
  for (const segment of segments) {
    el.appendChild(
      segment.think ? reasoningBlock(segment.text, !hasProse) : renderMarkdown(segment.text),
    )
  }
  return el
}

/** Tool line: "• <summary>" header with optional expandable body. */
function toolBlock({ summary, body, failed, expanded }) {
  const el = document.createElement("div")
  el.className = "line tool" + (failed ? " failed" : "")
  const header = document.createElement("div")
  header.className = "tool-header"
  const glyph = document.createElement("span")
  glyph.className = "tool-glyph"
  glyph.textContent = failed ? "✗" : "•"
  const label = document.createElement("span")
  label.className = "tool-label"
  label.textContent = summary
  header.append(glyph, label)
  el.appendChild(header)
  if (body && body.trim()) {
    const pre = document.createElement("pre")
    pre.className = "tool-output"
    pre.textContent = body.trim()
    pre.hidden = !expanded
    header.classList.add("expandable")
    header.addEventListener("click", () => {
      pre.hidden = !pre.hidden
    })
    el.appendChild(pre)
  }
  return el
}

function buildItemEl(item) {
  switch (item.type) {
    case "agent_message":
      return agentBlock(item.text || "")
    case "reasoning": {
      const el = document.createElement("div")
      el.className = "line"
      el.appendChild(reasoningBlock(item.text || ""))
      return el
    }
    case "command_execution": {
      const failed = item.status === "failed"
      const exit =
        item.exit_code !== undefined && item.exit_code !== 0 ? ` (exit ${item.exit_code})` : ""
      const pending = item.status === "in_progress" ? " …" : ""
      return toolBlock({
        summary: `$ ${item.command || ""}${exit}${pending}`,
        body: item.aggregated_output || "",
        failed,
        expanded: failed,
      })
    }
    case "file_change": {
      const changes = (item.changes || [])
        .map((c) => `${c.kind === "add" ? "+" : c.kind === "delete" ? "-" : "~"} ${c.path}`)
        .join("\n")
      const count = (item.changes || []).length
      return toolBlock({
        summary: `編輯 ${count} 個檔案`,
        body: changes,
        failed: item.status === "failed",
        expanded: true,
      })
    }
    case "mcp_tool_call":
      return toolBlock({
        summary: `工具 ${item.server ? item.server + "/" : ""}${item.tool || ""}`,
        failed: item.status === "failed",
      })
    case "web_search":
      return toolBlock({ summary: `網頁搜尋 ${item.query || ""}` })
    case "todo_list": {
      const todos = (item.items || [])
        .map((t) => `${t.completed ? "☑" : "☐"} ${t.text}`)
        .join("\n")
      return toolBlock({ summary: "計畫", body: todos, expanded: true })
    }
    case "error": {
      const el = document.createElement("div")
      el.className = "line error"
      el.textContent = item.message || "error"
      return el
    }
    default:
      return null
  }
}

function renderItem(item) {
  const el = buildItemEl(item)
  if (!el) {
    return
  }
  const key = item.id ? `${turnSeq}:${item.id}` : null
  const existing = key ? itemEls.get(key) : undefined
  if (existing) {
    existing.replaceWith(el)
  } else {
    appendLine(el)
  }
  if (key) {
    itemEls.set(key, el)
  }
  pinWorking()
  scrollToBottom()
}

// ---------- working indicator ----------

function setRunning(on) {
  running = on
  if (on && !workingEl) {
    workingStart = Date.now()
    workingEl = document.createElement("div")
    workingEl.className = "working"
    const label = document.createElement("span")
    label.className = "working-label"
    label.textContent = "思考中"
    const time = document.createElement("span")
    time.className = "working-time"
    time.textContent = "0s"
    workingEl.append(label, time)
    messagesEl.appendChild(workingEl)
    scrollToBottom()
    workingTimer = setInterval(() => {
      time.textContent = `${Math.round((Date.now() - workingStart) / 1000)}s`
    }, 1000)
  } else if (!on && workingEl) {
    clearInterval(workingTimer)
    workingTimer = null
    workingEl.remove()
    workingEl = null
  }
  sendEl.textContent = on ? "■" : "↑"
  sendEl.title = on ? "停止" : "送出 (Enter)"
}

function pinWorking() {
  if (workingEl && workingEl !== messagesEl.lastElementChild) {
    messagesEl.appendChild(workingEl)
  }
}

// ---------- views ----------

function showLogin() {
  loginView.hidden = false
  chatView.hidden = true
}

function showChat() {
  loginView.hidden = true
  chatView.hidden = false
  inputEl.focus()
}

// ---------- login ----------

$("login-unieai").addEventListener("click", () => startLogin(undefined))
$("login-company").addEventListener("click", () => {
  const url = $("company-url").value.trim()
  if (!url) {
    showLoginError("請先輸入公司 Studio 網址")
    return
  }
  startLogin(url)
})
$("login-cancel").addEventListener("click", () => {
  vscode.postMessage({ type: "cancelLogin" })
  $("login-pending").hidden = true
  setLoginButtonsEnabled(true)
})
$("login-link").addEventListener("click", (e) => {
  e.preventDefault()
  vscode.postMessage({ type: "openUrl", url: $("login-link").dataset.url })
})

function startLogin(studioUrl) {
  showLoginError("")
  setLoginButtonsEnabled(false)
  $("login-pending").hidden = false
  $("login-code").textContent = "…"
  vscode.postMessage({ type: "login", studioUrl })
}

function setLoginButtonsEnabled(enabled) {
  $("login-unieai").disabled = !enabled
  $("login-company").disabled = !enabled
}

function showLoginError(message) {
  const el = $("login-error")
  el.textContent = message
  el.hidden = !message
}

// ---------- notices ----------

function showNoModelsNotice() {
  const el = document.createElement("div")
  el.className = "line notice"
  const text = document.createElement("span")
  text.textContent = "你的帳戶還沒有可用模型。"
  const link = document.createElement("a")
  link.textContent = "到 UnieAI Studio 新增模型"
  link.addEventListener("click", () => {
    vscode.postMessage({ type: "openStudioModels", url: studioModelsUrl })
  })
  const tail = document.createElement("span")
  tail.textContent = "，然後重新登入。"
  el.append(text, link, tail)
  appendLine(el)
}

// ---------- events from exec ----------

function handleEvent(event) {
  switch (event.type) {
    case "turn.started":
      setRunning(true)
      break
    case "item.started":
    case "item.updated":
    case "item.completed":
      renderItem(event.item)
      break
    case "turn.completed":
      setRunning(false)
      break
    case "turn.failed":
      setRunning(false)
      errorLine((event.error && event.error.message) || "回合失敗")
      break
    case "error":
      errorLine(event.message || "error")
      break
  }
}

// ---------- composer ----------

function send() {
  if (running) {
    vscode.postMessage({ type: "stop" })
    return
  }
  const text = inputEl.value.trim()
  if (!text) {
    return
  }
  turnSeq += 1
  userLine(text)
  inputEl.value = ""
  setRunning(true)
  const sandbox = modeEl.value === "plan" ? "read-only" : permEl.value
  vscode.postMessage({
    type: "send",
    text,
    model: modelEl.value || undefined,
    sandbox,
    webAccess: webEl.value === "on",
  })
}

// ---------- slash commands ----------

const slashMenuEl = $("slash-menu")
const SLASH_COMMANDS = [
  { cmd: "/new", desc: "開新對話", run: () => vscode.postMessage({ type: "newChat" }) },
  { cmd: "/history", desc: "歷史 session", run: () => $("history-btn").click() },
  { cmd: "/logout", desc: "登出 UnieAI Studio", run: () => vscode.postMessage({ type: "logout" }) },
  { cmd: "/terminal", desc: "在終端開啟 TUI", run: () => vscode.postMessage({ type: "openTerminal" }) },
]
let slashSelected = 0

function slashCandidates() {
  const value = inputEl.value
  if (!value.startsWith("/") || /\s/.test(value)) {
    return []
  }
  return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(value))
}

function renderSlashMenu() {
  const candidates = slashCandidates()
  if (!candidates.length) {
    slashMenuEl.hidden = true
    return
  }
  slashSelected = Math.min(slashSelected, candidates.length - 1)
  slashMenuEl.innerHTML = ""
  candidates.forEach((candidate, index) => {
    const el = document.createElement("div")
    el.className = "slash-item" + (index === slashSelected ? " selected" : "")
    const cmd = document.createElement("span")
    cmd.className = "slash-cmd"
    cmd.textContent = candidate.cmd
    const desc = document.createElement("span")
    desc.className = "slash-desc"
    desc.textContent = candidate.desc
    el.append(cmd, desc)
    el.addEventListener("mousedown", (e) => {
      e.preventDefault()
      runSlash(candidate)
    })
    slashMenuEl.appendChild(el)
  })
  slashMenuEl.hidden = false
}

function runSlash(candidate) {
  inputEl.value = ""
  slashMenuEl.hidden = true
  slashSelected = 0
  candidate.run()
}

inputEl.addEventListener("input", () => {
  slashSelected = 0
  renderSlashMenu()
})

modelEl.addEventListener("change", () => {
  vscode.postMessage({ type: "setModel", model: modelEl.value })
})

webEl.addEventListener("change", () => {
  vscode.postMessage({ type: "setWebAccess", value: webEl.value === "on" })
})

sendEl.addEventListener("click", send)
inputEl.addEventListener("keydown", (e) => {
  // IME composition: Enter confirms the composition, not the message.
  if (e.isComposing || e.keyCode === 229) {
    return
  }
  const candidates = slashCandidates()
  if (!slashMenuEl.hidden && candidates.length) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      slashSelected = (slashSelected + 1) % candidates.length
      renderSlashMenu()
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      slashSelected = (slashSelected - 1 + candidates.length) % candidates.length
      renderSlashMenu()
      return
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      runSlash(candidates[slashSelected])
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      slashMenuEl.hidden = true
      return
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    send()
  }
})

// ---------- history ----------

$("history-btn").addEventListener("click", () => {
  historyList.innerHTML = '<div class="line meta">載入中…</div>'
  historyOverlay.hidden = false
  vscode.postMessage({ type: "listSessions" })
})
$("history-close").addEventListener("click", () => {
  historyOverlay.hidden = true
})
$("new-chat-btn").addEventListener("click", () => {
  vscode.postMessage({ type: "newChat" })
})
$("logout-btn").addEventListener("click", () => {
  vscode.postMessage({ type: "logout" })
})

function renderSessions(sessions) {
  historyList.innerHTML = ""
  if (!sessions.length) {
    historyList.innerHTML = '<div class="line meta">沒有歷史 session</div>'
    return
  }
  for (const session of sessions) {
    const el = document.createElement("button")
    el.className = "history-item"
    const when = new Date(session.mtime)
    const timeText = `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
    const folder = session.cwd ? session.cwd.split("/").pop() : ""
    const title = document.createElement("div")
    title.className = "history-preview"
    title.textContent = session.preview
    const sub = document.createElement("div")
    sub.className = "history-sub"
    sub.textContent = folder ? `${timeText} · ${folder}` : timeText
    el.append(title, sub)
    el.addEventListener("click", () => {
      historyOverlay.hidden = true
      vscode.postMessage({ type: "loadSession", path: session.path })
    })
    historyList.appendChild(el)
  }
}

// ---------- extension messages ----------

window.addEventListener("message", (e) => {
  const message = e.data
  switch (message.type) {
    case "bootstrap": {
      modelEl.innerHTML = ""
      for (const model of message.models || []) {
        const option = document.createElement("option")
        option.value = model.id
        option.textContent = model.name || model.id
        modelEl.appendChild(option)
      }
      if (
        message.currentModel &&
        [...modelEl.options].some((option) => option.value === message.currentModel)
      ) {
        modelEl.value = message.currentModel
      }
      webEl.value = message.webAccess ? "on" : "off"
      if (!message.signedIn) {
        showLogin()
      } else {
        showChat()
        if (!(message.models || []).length) {
          showNoModelsNotice()
        }
      }
      break
    }
    case "loginPrompt": {
      $("login-pending").hidden = false
      $("login-code").textContent = message.code || ""
      const link = $("login-link")
      link.textContent = message.url || ""
      link.dataset.url = message.url || ""
      break
    }
    case "loginDone":
      $("login-pending").hidden = true
      setLoginButtonsEnabled(true)
      break
    case "loginError":
      $("login-pending").hidden = true
      setLoginButtonsEnabled(true)
      showLoginError(message.message || "登入失敗")
      break
    case "event":
      handleEvent(message.event)
      break
    case "running":
      setRunning(Boolean(message.value))
      break
    case "insert":
      inputEl.value += message.text
      inputEl.focus()
      break
    case "reset":
      messagesEl.innerHTML = ""
      itemEls.clear()
      turnSeq += 1
      setRunning(false)
      break
    case "sessions":
      renderSessions(message.sessions || [])
      break
    case "sessionLoaded": {
      messagesEl.innerHTML = ""
      itemEls.clear()
      turnSeq += 1
      setRunning(false)
      for (const item of message.items || []) {
        if (item.role === "user") {
          userLine(item.text)
        } else if (item.role === "tool") {
          appendLine(toolBlock({ summary: item.text }))
        } else {
          appendLine(agentBlock(item.text))
        }
      }
      metaLine("已載入歷史 session — 繼續輸入即可接續此對話")
      break
    }
    case "stderr":
      metaLine(message.text)
      break
    case "fatal":
      setRunning(false)
      errorLine(message.message)
      break
  }
})

vscode.postMessage({ type: "ready" })
