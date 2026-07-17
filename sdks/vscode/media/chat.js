// UnieAI Code chat panel — renders `unieai exec --experimental-json` thread
// events forwarded by the extension host.
(function () {
  const vscode = acquireVsCodeApi()

  const messagesEl = document.getElementById("messages")
  const inputEl = document.getElementById("input")
  const sendEl = document.getElementById("send")
  const stopEl = document.getElementById("stop")
  const modelEl = document.getElementById("model")

  /** item id -> rendered element, so item.updated/completed replace in place */
  const itemEls = new Map()
  let workingEl = null
  let studioModelsUrl = "https://studio.unieai.com/models"

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

  function setWorking(on) {
    if (on && !workingEl) {
      workingEl = document.createElement("div")
      workingEl.className = "working"
      workingEl.innerHTML = '<span class="dot"></span><span>Working…</span>'
      messagesEl.appendChild(workingEl)
      scrollToBottom()
    } else if (!on && workingEl) {
      workingEl.remove()
      workingEl = null
    }
    stopEl.hidden = !on
    sendEl.disabled = on
  }

  function describeItem(item) {
    switch (item.type) {
      case "agent_message":
        return { className: "agent", text: item.text || "" }
      case "reasoning":
        return { className: "reasoning", text: item.text || "" }
      case "command_execution": {
        const status = item.status === "failed" ? " ✗" : item.status === "completed" ? "" : " …"
        const exit = item.exit_code !== undefined && item.exit_code !== 0 ? ` (exit ${item.exit_code})` : ""
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
          text: `edit\n${changes}`,
        }
      }
      case "mcp_tool_call":
        return {
          className: "tool" + (item.status === "failed" ? " failed" : ""),
          text: `tool ${item.server ? item.server + "/" : ""}${item.tool || ""}`,
        }
      case "web_search":
        return { className: "tool", text: `web search: ${item.query || ""}` }
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
      case "thread.started":
        break
      case "turn.started":
        setWorking(true)
        break
      case "item.started":
      case "item.updated":
      case "item.completed":
        renderItem(event.item)
        break
      case "turn.completed": {
        setWorking(false)
        const usage = event.usage
        if (usage) {
          addMessage("meta", `${usage.input_tokens + usage.output_tokens} tokens`)
        }
        break
      }
      case "turn.failed":
        setWorking(false)
        addMessage("error", (event.error && event.error.message) || "Turn failed")
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
    text.textContent = "No models are available for your UnieAI account yet. "
    const link = document.createElement("a")
    link.textContent = "Add models in UnieAI Studio"
    link.addEventListener("click", () => {
      vscode.postMessage({ type: "openStudioModels", url: studioModelsUrl })
    })
    const tail = document.createElement("span")
    tail.textContent = ", then sign in again with `unieai login`."
    el.append(text, link, tail)
    messagesEl.appendChild(el)
    scrollToBottom()
  }

  function showSignInNotice() {
    const el = document.createElement("div")
    el.className = "msg notice"
    el.textContent = "Not signed in. Run `unieai login` in a terminal, then start a new chat here."
    messagesEl.appendChild(el)
    scrollToBottom()
  }

  function send() {
    const text = inputEl.value.trim()
    if (!text) {
      return
    }
    addMessage("user", text)
    inputEl.value = ""
    vscode.postMessage({ type: "send", text, model: modelEl.value || undefined })
  }

  sendEl.addEventListener("click", send)
  stopEl.addEventListener("click", () => vscode.postMessage({ type: "stop" }))
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  })

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
          showSignInNotice()
        } else if (!(message.models || []).length) {
          showNoModelsNotice()
        }
        break
      }
      case "event":
        handleEvent(message.event)
        break
      case "running":
        setWorking(Boolean(message.value))
        break
      case "insert":
        inputEl.value += message.text
        inputEl.focus()
        break
      case "reset":
        messagesEl.innerHTML = ""
        itemEls.clear()
        setWorking(false)
        break
      case "stderr":
        addMessage("meta", message.text)
        break
      case "fatal":
        setWorking(false)
        addMessage("error", message.message)
        break
    }
  })

  vscode.postMessage({ type: "ready" })
})()
