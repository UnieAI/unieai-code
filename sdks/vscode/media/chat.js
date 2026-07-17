// UnieAI Code chat panel — sign-in, chat over `unieai exec --experimental-json`
// events, and session history.
(function () {
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
  const historyOverlay = $("history-overlay")
  const historyList = $("history-list")

  /** item id -> element so item.updated/completed re-render in place */
  const itemEls = new Map()
  let workingEl = null
  let running = false
  let studioModelsUrl = "https://studio.unieai.com/models"

  // ---------- view switching ----------

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

  $("login-unieai").addEventListener("click", () => {
    startLogin(undefined)
  })
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

  // ---------- chat rendering ----------

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function addMessage(className, text) {
    const el = document.createElement("div")
    el.className = "msg " + className
    el.textContent = text
    messagesEl.appendChild(el)
    scrollToBottom()
    return el
  }

  function setRunning(on) {
    running = on
    if (on && !workingEl) {
      workingEl = document.createElement("div")
      workingEl.className = "working"
      workingEl.innerHTML = '<span class="dot"></span><span>思考中…</span>'
      messagesEl.appendChild(workingEl)
      scrollToBottom()
    } else if (!on && workingEl) {
      workingEl.remove()
      workingEl = null
    }
    sendEl.textContent = on ? "■" : "↑"
    sendEl.title = on ? "停止" : "送出 (Enter)"
  }

  function describeItem(item) {
    switch (item.type) {
      case "agent_message":
        return { className: "agent", text: item.text || "" }
      case "reasoning":
        return { className: "reasoning", text: item.text || "" }
      case "command_execution": {
        const status = item.status === "failed" ? " ✗" : item.status === "completed" ? "" : " …"
        const exit =
          item.exit_code !== undefined && item.exit_code !== 0 ? ` (exit ${item.exit_code})` : ""
        return {
          className: "tool" + (item.status === "failed" ? " failed" : ""),
          text: `$ ${item.command || ""}${status}${exit}`,
        }
      }
      case "file_change": {
        const changes = (item.changes || [])
          .map((c) => `${c.kind === "add" ? "+" : c.kind === "delete" ? "-" : "~"} ${c.path}`)
          .join("\n")
        return {
          className: "tool" + (item.status === "failed" ? " failed" : ""),
          text: `編輯檔案\n${changes}`,
        }
      }
      case "mcp_tool_call":
        return {
          className: "tool" + (item.status === "failed" ? " failed" : ""),
          text: `工具 ${item.server ? item.server + "/" : ""}${item.tool || ""}`,
        }
      case "web_search":
        return { className: "tool", text: `網頁搜尋：${item.query || ""}` }
      case "todo_list": {
        const todos = (item.items || [])
          .map((t) => `${t.completed ? "☑" : "☐"} ${t.text}`)
          .join("\n")
        return { className: "tool", text: todos }
      }
      case "error":
        return { className: "error", text: item.message || "error" }
      default:
        return null
    }
  }

  function renderItem(item) {
    const described = describeItem(item)
    if (!described) {
      return
    }
    const key = item.id
    let el = key ? itemEls.get(key) : undefined
    if (!el) {
      el = addMessage(described.className, described.text)
      if (key) {
        itemEls.set(key, el)
      }
    } else {
      el.className = "msg " + described.className
      el.textContent = described.text
    }
    scrollToBottom()
  }

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
      case "turn.completed": {
        setRunning(false)
        if (event.usage) {
          addMessage(
            "meta",
            `${event.usage.input_tokens + event.usage.output_tokens} tokens`,
          )
        }
        break
      }
      case "turn.failed":
        setRunning(false)
        addMessage("error", (event.error && event.error.message) || "回合失敗")
        break
      case "error":
        addMessage("error", event.message || "error")
        break
    }
  }

  function showNoModelsNotice() {
    const el = document.createElement("div")
    el.className = "msg notice"
    const text = document.createElement("span")
    text.textContent = "你的帳戶還沒有可用模型。"
    const link = document.createElement("a")
    link.textContent = "到 UnieAI Studio 新增模型"
    link.addEventListener("click", () => {
      vscode.postMessage({ type: "openStudioModels", url: studioModelsUrl })
    })
    const tail = document.createElement("span")
    tail.textContent = "，然後重新執行 unieai login。"
    el.append(text, link, tail)
    messagesEl.appendChild(el)
    scrollToBottom()
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
    addMessage("user", text)
    inputEl.value = ""
    const sandbox = modeEl.value === "plan" ? "read-only" : permEl.value
    vscode.postMessage({ type: "send", text, model: modelEl.value || undefined, sandbox })
  }

  // ---------- slash commands ----------

  const slashMenuEl = $("slash-menu")
  const SLASH_COMMANDS = [
    { cmd: "/new", desc: "開新對話", run: () => vscode.postMessage({ type: "newChat" }) },
    {
      cmd: "/history",
      desc: "歷史 session",
      run: () => $("history-btn").click(),
    },
    { cmd: "/logout", desc: "登出 UnieAI Studio", run: () => vscode.postMessage({ type: "logout" }) },
    {
      cmd: "/terminal",
      desc: "在終端開啟 TUI",
      run: () => vscode.postMessage({ type: "openTerminal" }),
    },
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

  sendEl.addEventListener("click", send)
  inputEl.addEventListener("keydown", (e) => {
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
    historyList.innerHTML = '<div class="msg meta">載入中…</div>'
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
      historyList.innerHTML = '<div class="msg meta">沒有歷史 session</div>'
      return
    }
    for (const session of sessions) {
      const el = document.createElement("button")
      el.className = "history-item"
      const when = new Date(session.mtime)
      const timeText = `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
      const folder = session.cwd ? session.cwd.split("/").pop() : ""
      el.innerHTML = ""
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
      case "loginPrompt":
        $("login-pending").hidden = false
        $("login-code").textContent = message.code || ""
        {
          const link = $("login-link")
          link.textContent = message.url || ""
          link.dataset.url = message.url || ""
        }
        break
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
        setRunning(false)
        break
      case "sessions":
        renderSessions(message.sessions || [])
        break
      case "sessionLoaded": {
        messagesEl.innerHTML = ""
        itemEls.clear()
        setRunning(false)
        for (const item of message.items || []) {
          addMessage(item.role === "user" ? "user" : "agent", item.text)
        }
        addMessage("meta", "已載入歷史 session — 繼續輸入即可接續此對話")
        break
      }
      case "stderr":
        addMessage("meta", message.text)
        break
      case "fatal":
        setRunning(false)
        addMessage("error", message.message)
        break
    }
  })

  vscode.postMessage({ type: "ready" })
})()
