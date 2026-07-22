// UnieAI Code chat panel webview. TUI-flat transcript: "›" user lines,
// markdown-rendered agent prose, "•" tool lines with expandable output,
// collapsed reasoning (both reasoning items and inline <think> blocks).
import { marked } from "marked"

const vscode = acquireVsCodeApi()

// ---------- i18n ----------
// The static HTML arrives pre-translated from the extension host; this
// dictionary covers everything the webview renders dynamically. `L` defaults
// to zh-TW and is switched by the `bootstrap` message's locale.
const I18N = {
  "zh-TW": {
    copy: "複製",
    copied: "已複製",
    copyCode: "複製程式碼",
    copyMarkdown: "複製為 Markdown",
    thinking: "思考過程",
    thinkingLive: "思考中",
    steerTag: "↳ 插話",
    openInEditor: "在編輯器中開啟",
    toolRead: "讀取",
    toolWrite: "寫入",
    toolEdit: "編輯",
    tool: (x) => `工具 ${x}`,
    webSearch: (q) => `網頁搜尋 ${q}`,
    multiAgent: (x) => `多代理 ${x}`,
    autoReview: (a) => `· 自動審查 ${a}`,
    waiting: (s) => (s == null ? "· 等待" : `· 等待 ${s}s`),
    compacted: "· 已壓縮較早的對話以節省上下文",
    reviewEnter: "· 進入審查模式",
    reviewExit: "· 離開審查模式",
    editedFiles: (n, stat) => `編輯 ${n} 個檔案${stat}`,
    planTitle: "計畫",
    image: "圖片",
    imageStatus: (sym) => `圖片 ${sym}`,
    subStarted: "啟動",
    subCompleted: "完成",
    subagent: (name, kind) => `子代理 ${name} ${kind}`,
    approveCommand: "請求核准：執行指令",
    approveFileChange: "請求核准：修改檔案",
    approvePermissions: "請求核准：權限提升",
    allowOnce: "允許一次",
    allowSession: "本次對話都允許",
    deny: "拒絕",
    denyAbort: "拒絕並中斷",
    needDecision: "需要你的決定",
    pleaseChoose: "請選擇",
    chosen: (x) => `已選擇：${x}`,
    skipped: "已跳過",
    skip: "跳過",
    question: "問題",
    submit: "送出",
    answered: "已回覆",
    steerBtn: "插話",
    steerTitle: "插話：把訊息折入目前回合 (Enter)",
    sendTitle: "送出 (Enter)",
    hintSteering: "Enter 插話 · Shift+Enter 換行 · ■ 停止",
    hintIdle: "Enter 送出 · Shift+Enter 換行 · / 指令",
    emptyState: "問我任何事，或輸入 / 使用指令",
    enterCompanyUrl: "請先輸入公司 Studio 網址",
    noModels: "你的帳戶還沒有可用模型。",
    addModels: "到 UnieAI Studio 新增模型",
    thenRelogin: "，然後重新登入。",
    turnFailed: "回合失敗",
    retry: "重試",
    interrupted: "已中斷",
    sessionLoadedMeta: "已載入歷史 session — 繼續輸入即可接續此對話",
    loading: "載入中…",
    noSessions: "沒有歷史 session",
    loginFailed: "登入失敗",
    steerUndelivered: "（未送達：已放回輸入框，Enter 直接送出）",
    switchedPlan: "已切到規劃模式",
    switchedExec: "已切回執行模式",
    metaWebOn: "上網：開",
    metaWebOff: "上網：關",
    goalReview: "目標模式：背景審查 — 回合照常即收，驗證在背景跑，發現缺口會提示你回「繼續」補完",
    goalGate: "目標模式：嚴格把關 — 回合結束前自我驗證並當場補漏（尾端會多幾次模型呼叫）",
    goalOff: "目標模式：關",
    commandsList: (cmds) => `指令：${cmds}`,
    tokenMeter: (k) => `${k}k tokens`,
    slashNew: "開新對話",
    slashHistory: "歷史 session",
    slashModel: "切換模型",
    slashPlan: "切到規劃模式（唯讀探索）",
    slashExec: "切回執行模式",
    slashWeb: "切換允許連網",
    slashPerm: "切換權限（預設/唯讀/完全存取）",
    slashGoal: "循環目標模式：關 → 背景審查（零延遲）→ 嚴格把關（擋回合尾）",
    slashRetry: "重試上一回合",
    slashEngine: "切換引擎 (app-server / agent-core)",
    slashStop: "中斷目前回合",
    slashLogout: "登出 UnieAI Studio",
    slashTerminal: "在終端開啟 TUI",
    slashHelp: "列出所有指令",
    slashRewind: "檢視回捲點（每回合的檔案快照，唯讀）",
    rewindTitle: "回捲點",
    rewindEmpty: "尚無回捲點（改過檔案的回合才會建立快照）",
    rewindPoint: (i, time, n) => `#${i} · ${time} · ${n} 個檔案變更`,
  },
  "zh-CN": {
    copy: "复制",
    copied: "已复制",
    copyCode: "复制代码",
    copyMarkdown: "复制为 Markdown",
    thinking: "思考过程",
    thinkingLive: "思考中",
    steerTag: "↳ 插话",
    openInEditor: "在编辑器中打开",
    toolRead: "读取",
    toolWrite: "写入",
    toolEdit: "编辑",
    tool: (x) => `工具 ${x}`,
    webSearch: (q) => `网页搜索 ${q}`,
    multiAgent: (x) => `多代理 ${x}`,
    autoReview: (a) => `· 自动审查 ${a}`,
    waiting: (s) => (s == null ? "· 等待" : `· 等待 ${s}s`),
    compacted: "· 已压缩较早的对话以节省上下文",
    reviewEnter: "· 进入审查模式",
    reviewExit: "· 离开审查模式",
    editedFiles: (n, stat) => `编辑 ${n} 个文件${stat}`,
    planTitle: "计划",
    image: "图片",
    imageStatus: (sym) => `图片 ${sym}`,
    subStarted: "启动",
    subCompleted: "完成",
    subagent: (name, kind) => `子代理 ${name} ${kind}`,
    approveCommand: "请求审批：执行命令",
    approveFileChange: "请求审批：修改文件",
    approvePermissions: "请求审批：权限提升",
    allowOnce: "允许一次",
    allowSession: "本次会话都允许",
    deny: "拒绝",
    denyAbort: "拒绝并中断",
    needDecision: "需要你的决定",
    pleaseChoose: "请选择",
    chosen: (x) => `已选择：${x}`,
    skipped: "已跳过",
    skip: "跳过",
    question: "问题",
    submit: "发送",
    answered: "已回复",
    steerBtn: "插话",
    steerTitle: "插话：把消息并入当前回合 (Enter)",
    sendTitle: "发送 (Enter)",
    hintSteering: "Enter 插话 · Shift+Enter 换行 · ■ 停止",
    hintIdle: "Enter 发送 · Shift+Enter 换行 · / 命令",
    emptyState: "问我任何事，或输入 / 使用命令",
    enterCompanyUrl: "请先输入公司 Studio 网址",
    noModels: "你的账户还没有可用模型。",
    addModels: "到 UnieAI Studio 添加模型",
    thenRelogin: "，然后重新登录。",
    turnFailed: "回合失败",
    retry: "重试",
    interrupted: "已中断",
    sessionLoadedMeta: "已加载历史会话 — 继续输入即可接续此对话",
    loading: "加载中…",
    noSessions: "没有历史会话",
    loginFailed: "登录失败",
    steerUndelivered: "（未送达：已放回输入框，Enter 直接发送）",
    switchedPlan: "已切到规划模式",
    switchedExec: "已切回执行模式",
    metaWebOn: "联网：开",
    metaWebOff: "联网：关",
    goalReview: "目标模式：后台审查 — 回合照常结束，验证在后台运行，发现缺口会提示你回复“继续”补完",
    goalGate: "目标模式：严格把关 — 回合结束前自我验证并当场补漏（尾部会多几次模型调用）",
    goalOff: "目标模式：关",
    commandsList: (cmds) => `命令：${cmds}`,
    tokenMeter: (k) => `${k}k tokens`,
    slashNew: "开新对话",
    slashHistory: "历史会话",
    slashModel: "切换模型",
    slashPlan: "切到规划模式（只读探索）",
    slashExec: "切回执行模式",
    slashWeb: "切换允许联网",
    slashPerm: "切换权限（默认/只读/完全访问）",
    slashGoal: "循环目标模式：关 → 后台审查（零延迟）→ 严格把关（阻塞回合尾）",
    slashRetry: "重试上一回合",
    slashEngine: "切换引擎 (app-server / agent-core)",
    slashStop: "中断当前回合",
    slashLogout: "退出 UnieAI Studio",
    slashTerminal: "在终端打开 TUI",
    slashHelp: "列出所有命令",
    slashRewind: "查看回卷点（每回合的文件快照，只读）",
    rewindTitle: "回卷点",
    rewindEmpty: "暂无回卷点（修改过文件的回合才会创建快照）",
    rewindPoint: (i, time, n) => `#${i} · ${time} · ${n} 个文件变更`,
  },
  en: {
    copy: "Copy",
    copied: "Copied",
    copyCode: "Copy code",
    copyMarkdown: "Copy as Markdown",
    thinking: "Thinking",
    thinkingLive: "Thinking",
    steerTag: "↳ Interject",
    openInEditor: "Open in editor",
    toolRead: "Read",
    toolWrite: "Write",
    toolEdit: "Edit",
    tool: (x) => `Tool ${x}`,
    webSearch: (q) => `Web search ${q}`,
    multiAgent: (x) => `Multi-agent ${x}`,
    autoReview: (a) => `· Auto review ${a}`,
    waiting: (s) => (s == null ? "· Waiting" : `· Waiting ${s}s`),
    compacted: "· Compacted earlier conversation to save context",
    reviewEnter: "· Entered review mode",
    reviewExit: "· Exited review mode",
    editedFiles: (n, stat) => `Edited ${n} file${n === 1 ? "" : "s"}${stat}`,
    planTitle: "Plan",
    image: "Image",
    imageStatus: (sym) => `Image ${sym}`,
    subStarted: "started",
    subCompleted: "completed",
    subagent: (name, kind) => `Subagent ${name} ${kind}`,
    approveCommand: "Approval requested: run command",
    approveFileChange: "Approval requested: edit files",
    approvePermissions: "Approval requested: elevated permissions",
    allowOnce: "Allow once",
    allowSession: "Allow for this chat",
    deny: "Deny",
    denyAbort: "Deny and stop",
    needDecision: "Your decision needed",
    pleaseChoose: "Choose an option",
    chosen: (x) => `Selected: ${x}`,
    skipped: "Skipped",
    skip: "Skip",
    question: "Question",
    submit: "Submit",
    answered: "Answered",
    steerBtn: "Interject",
    steerTitle: "Interject: fold this message into the running turn (Enter)",
    sendTitle: "Send (Enter)",
    hintSteering: "Enter to interject · Shift+Enter for newline · ■ to stop",
    hintIdle: "Enter to send · Shift+Enter for newline · / for commands",
    emptyState: "Ask me anything, or type / for commands",
    enterCompanyUrl: "Enter your company Studio URL first",
    noModels: "Your account has no models yet. ",
    addModels: "Add models in UnieAI Studio",
    thenRelogin: ", then sign in again.",
    turnFailed: "Turn failed",
    retry: "Retry",
    interrupted: "Interrupted",
    sessionLoadedMeta: "Session loaded — keep typing to continue this conversation",
    loading: "Loading…",
    noSessions: "No past sessions",
    loginFailed: "Sign-in failed",
    steerUndelivered: "(not delivered — returned to the input box, press Enter to send)",
    switchedPlan: "Switched to plan mode",
    switchedExec: "Switched back to run mode",
    metaWebOn: "Web access: on",
    metaWebOff: "Web access: off",
    goalReview:
      "Goal mode: background review — turns end normally, verification runs in the background, and you'll be prompted to reply \"continue\" if gaps are found",
    goalGate:
      "Goal mode: strict gate — self-verifies and fixes gaps before the turn ends (a few extra model calls at the end)",
    goalOff: "Goal mode: off",
    commandsList: (cmds) => `Commands: ${cmds}`,
    tokenMeter: (k) => `${k}k tokens`,
    slashNew: "Start a new chat",
    slashHistory: "Session history",
    slashModel: "Switch model",
    slashPlan: "Switch to plan mode (read-only exploration)",
    slashExec: "Switch back to run mode",
    slashWeb: "Toggle network access",
    slashPerm: "Cycle permissions (default / read-only / full access)",
    slashGoal: "Cycle goal mode: off → background review (zero latency) → strict gate (blocks turn end)",
    slashRetry: "Retry the last turn",
    slashEngine: "Switch engine (app-server / agent-core)",
    slashStop: "Stop the current turn",
    slashLogout: "Sign out of UnieAI Studio",
    slashTerminal: "Open the TUI in a terminal",
    slashHelp: "List all commands",
    slashRewind: "View rewind points (per-turn file snapshots, read-only)",
    rewindTitle: "Rewind points",
    rewindEmpty: "No rewind points yet (snapshots are taken on turns that changed files)",
    rewindPoint: (i, time, n) => `#${i} · ${time} · ${n} file(s) changed`,
  },
  ja: {
    copy: "コピー",
    copied: "コピー済み",
    copyCode: "コードをコピー",
    copyMarkdown: "Markdown としてコピー",
    thinking: "思考プロセス",
    thinkingLive: "思考中",
    steerTag: "↳ 割り込み",
    openInEditor: "エディタで開く",
    toolRead: "読み取り",
    toolWrite: "書き込み",
    toolEdit: "編集",
    tool: (x) => `ツール ${x}`,
    webSearch: (q) => `ウェブ検索 ${q}`,
    multiAgent: (x) => `マルチエージェント ${x}`,
    autoReview: (a) => `· 自動レビュー ${a}`,
    waiting: (s) => (s == null ? "· 待機中" : `· 待機中 ${s}s`),
    compacted: "· コンテキスト節約のため以前の会話を圧縮しました",
    reviewEnter: "· レビューモード開始",
    reviewExit: "· レビューモード終了",
    editedFiles: (n, stat) => `${n} 個のファイルを編集${stat}`,
    planTitle: "プラン",
    image: "画像",
    imageStatus: (sym) => `画像 ${sym}`,
    subStarted: "起動",
    subCompleted: "完了",
    subagent: (name, kind) => `サブエージェント ${name} ${kind}`,
    approveCommand: "承認リクエスト: コマンド実行",
    approveFileChange: "承認リクエスト: ファイル変更",
    approvePermissions: "承認リクエスト: 権限昇格",
    allowOnce: "1回許可",
    allowSession: "このチャットでは常に許可",
    deny: "拒否",
    denyAbort: "拒否して中断",
    needDecision: "あなたの判断が必要です",
    pleaseChoose: "選択してください",
    chosen: (x) => `選択: ${x}`,
    skipped: "スキップしました",
    skip: "スキップ",
    question: "質問",
    submit: "送信",
    answered: "回答済み",
    steerBtn: "割り込み",
    steerTitle: "割り込み: 実行中のターンにメッセージを差し込む (Enter)",
    sendTitle: "送信 (Enter)",
    hintSteering: "Enter 割り込み · Shift+Enter 改行 · ■ 停止",
    hintIdle: "Enter 送信 · Shift+Enter 改行 · / コマンド",
    emptyState: "何でも質問してください。/ でコマンド一覧",
    enterCompanyUrl: "会社の Studio URL を入力してください",
    noModels: "アカウントに利用可能なモデルがありません。",
    addModels: "UnieAI Studio でモデルを追加",
    thenRelogin: "してから、再度サインインしてください。",
    turnFailed: "ターンが失敗しました",
    retry: "再試行",
    interrupted: "中断しました",
    sessionLoadedMeta: "セッションを読み込みました — 入力を続けるとこの会話を再開できます",
    loading: "読み込み中…",
    noSessions: "セッション履歴はありません",
    loginFailed: "サインインに失敗しました",
    steerUndelivered: "（未送達: 入力欄に戻しました。Enter で送信）",
    switchedPlan: "プランモードに切り替えました",
    switchedExec: "実行モードに戻しました",
    metaWebOn: "ネット接続: オン",
    metaWebOff: "ネット接続: オフ",
    goalReview:
      "ゴールモード: バックグラウンドレビュー — ターンは通常どおり終了し、検証は裏で実行。不足があれば「続けて」と返信するよう促されます",
    goalGate:
      "ゴールモード: 厳格ゲート — ターン終了前に自己検証して不足をその場で補完（終盤にモデル呼び出しが数回増えます）",
    goalOff: "ゴールモード: オフ",
    commandsList: (cmds) => `コマンド: ${cmds}`,
    tokenMeter: (k) => `${k}k tokens`,
    slashNew: "新しいチャット",
    slashHistory: "セッション履歴",
    slashModel: "モデル切替",
    slashPlan: "プランモードへ（読み取り専用で調査）",
    slashExec: "実行モードに戻る",
    slashWeb: "ネット接続の切替",
    slashPerm: "権限の切替（標準 / 読み取り専用 / フルアクセス）",
    slashGoal: "ゴールモード切替: オフ → バックグラウンドレビュー（遅延なし）→ 厳格ゲート（ターン終了をブロック）",
    slashRetry: "前のターンを再試行",
    slashEngine: "エンジン切替 (app-server / agent-core)",
    slashStop: "現在のターンを中断",
    slashLogout: "UnieAI Studio からサインアウト",
    slashTerminal: "ターミナルで TUI を開く",
    slashHelp: "コマンド一覧",
    slashRewind: "巻き戻しポイントを表示（ターンごとのファイルスナップショット・読み取り専用）",
    rewindTitle: "巻き戻しポイント",
    rewindEmpty: "巻き戻しポイントはまだありません（ファイルを変更したターンで作成されます）",
    rewindPoint: (i, time, n) => `#${i} · ${time} · ${n} 件のファイル変更`,
  },
}

let L = I18N["zh-TW"]

const $ = (id) => document.getElementById(id)
const loginView = $("login-view")
const chatView = $("chat-view")
const messagesEl = $("messages")
const inputEl = $("input")
const sendEl = $("send")
const stopEl = $("stop")
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
let goalMode = false
let studioModelsUrl = "https://studio.unieai.com/models"

// ---------- helpers ----------

// Only auto-scroll while the user is already reading the tail; don't yank
// them down while they're scrolled up reviewing earlier output.
let stickToBottom = true
messagesEl.addEventListener("scroll", () => {
  stickToBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80
})

// Coalesce scrolls to one per animation frame: reading scrollHeight forces a
// synchronous layout, and streaming can request dozens of scrolls per second.
let scrollScheduled = false
function scrollToBottom() {
  if (!stickToBottom || scrollScheduled) {
    return
  }
  scrollScheduled = true
  requestAnimationFrame(() => {
    scrollScheduled = false
    if (stickToBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight
    }
  })
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
  // Add a hover "copy" affordance to every fenced code block.
  for (const pre of container.querySelectorAll("pre")) {
    const code = pre.querySelector("code") || pre
    const btn = document.createElement("button")
    btn.className = "code-copy"
    btn.type = "button"
    btn.textContent = L.copy
    btn.title = L.copyCode
    btn.addEventListener("click", (e) => {
      e.stopPropagation()
      copyText(code.textContent || "", btn, L.copy)
    })
    pre.classList.add("has-copy")
    pre.appendChild(btn)
  }
  return container
}

/** Copy via the extension host (vscode.env.clipboard); optimistic label flip. */
function copyText(text, btn, restore) {
  vscode.postMessage({ type: "copy", text })
  if (btn) {
    btn.textContent = L.copied
    btn.classList.add("copied")
    setTimeout(() => {
      btn.textContent = restore
      btn.classList.remove("copied")
    }, 1200)
  }
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

function reasoningBlock(text, open = false, label = null) {
  const details = document.createElement("details")
  details.className = "reasoning"
  if (open) {
    details.open = true
  }
  const summary = document.createElement("summary")
  summary.textContent = label || L.thinking
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

/** A mid-turn interjection (steer): a distinct user line that reads as folded
 * into the running turn, e.g. "↳ <interject tag>  <text>". */
function steerLine(text) {
  const el = document.createElement("div")
  el.className = "line user steer"
  const tag = document.createElement("span")
  tag.className = "steer-tag"
  tag.textContent = L.steerTag
  const body = document.createElement("span")
  body.className = "steer-text"
  body.textContent = text
  el.append(tag, body)
  return appendLine(el)
}

/** Diagnostic noise that must not reach the transcript. */
function isNoise(text) {
  return /was recorded with model .* resuming with|Consider switching back/i.test(text)
}

function metaLine(text) {
  if (isNoise(text)) {
    return null
  }
  const el = document.createElement("div")
  el.className = "line meta"
  el.textContent = text
  return appendLine(el)
}

function errorLine(text) {
  if (isNoise(text)) {
    return null
  }
  const el = document.createElement("div")
  el.className = "line error"
  el.textContent = text
  return appendLine(el)
}

function agentBlock(text, citations) {
  const el = document.createElement("div")
  el.className = "line agent"
  // Hover affordance: copy the message as raw markdown.
  const copy = document.createElement("button")
  copy.className = "msg-copy"
  copy.type = "button"
  copy.textContent = L.copy
  copy.title = L.copyMarkdown
  copy.addEventListener("click", () => copyText(text, copy, L.copy))
  el.appendChild(copy)
  const segments = splitThinking(text)
  // A model may wrap its entire reply in an (unclosed) <think> block; keep it
  // visible by auto-opening when there is no prose left at all.
  const hasProse = segments.some((s) => !s.think)
  for (const segment of segments) {
    el.appendChild(
      segment.think ? reasoningBlock(segment.text, !hasProse) : renderMarkdown(segment.text),
    )
  }
  if (Array.isArray(citations) && citations.length) {
    const foot = document.createElement("div")
    foot.className = "citations"
    for (const c of citations) {
      if (!c.path) continue
      const a = document.createElement("a")
      const range = c.lineStart ? `:${c.lineStart}${c.lineEnd && c.lineEnd !== c.lineStart ? "-" + c.lineEnd : ""}` : ""
      a.textContent = `↪ ${c.path}${range}`
      a.title = c.note || L.openInEditor
      a.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: c.path }))
      foot.appendChild(a)
    }
    if (foot.childElementCount) el.appendChild(foot)
  }
  return el
}

/** Tool line: "• <summary>" header with optional expandable body.
 * `status` (in_progress|completed|failed) drives the leading glyph/spinner;
 * `failed` is kept for older callers. `badge` renders a small trailing pill
 * (e.g. "exit 1"). `mono` renders the label in the editor font (bash). */
function toolBlock({ summary, body, failed, expanded, status, badge, mono }) {
  const running = status === "in_progress"
  const isFailed = failed || status === "failed"
  const el = document.createElement("div")
  el.className =
    "line tool" + (isFailed ? " failed" : "") + (running ? " running" : "")
  const header = document.createElement("div")
  header.className = "tool-header"
  const glyph = document.createElement("span")
  glyph.className = "tool-glyph"
  if (running) {
    glyph.classList.add("spinner")
    glyph.textContent = ""
  } else {
    glyph.textContent = isFailed ? "✗" : "•"
  }
  const label = document.createElement("span")
  label.className = "tool-label" + (mono ? " mono" : "")
  label.textContent = summary
  header.append(glyph, label)
  if (badge) {
    const b = document.createElement("span")
    b.className = "tool-badge" + (isFailed ? " bad" : "")
    b.textContent = badge
    header.appendChild(b)
  }
  el.appendChild(header)
  if (body && body.trim()) {
    const chevron = document.createElement("span")
    chevron.className = "tool-chevron"
    chevron.textContent = "▸"
    header.appendChild(chevron)
    const pre = document.createElement("pre")
    pre.className = "tool-output"
    pre.textContent = body.trim()
    pre.hidden = !expanded
    if (expanded) chevron.classList.add("open")
    header.classList.add("expandable")
    header.addEventListener("click", () => {
      pre.hidden = !pre.hidden
      chevron.classList.toggle("open", !pre.hidden)
    })
    el.appendChild(pre)
  }
  return el
}

/** File-path glyphs for read/write/edit tool cards. */
const FILE_TOOL_GLYPH = { read: "◇", write: "＋", edit: "✎" }

/** Per-tool command_execution card. bash → "$ cmd" + exit badge; read/write/
 * edit → file verb; otherwise a generic tool line. Output is collapsible. */
function commandExecutionBlock(item) {
  const tool = (item.tool_name || "").toLowerCase()
  const status = item.status
  const failed = status === "failed"
  const running = status === "in_progress"
  const output = item.aggregated_output || ""
  const hasExit = item.exit_code !== undefined && item.exit_code !== null
  const nonZero = hasExit && item.exit_code !== 0

  // read/write/edit — show the file verb + any path we can recover.
  if (tool === "read" || tool === "write" || tool === "edit") {
    const verb = tool === "read" ? L.toolRead : tool === "write" ? L.toolWrite : L.toolEdit
    const path = filePathFromCommand(item.command, tool) || firstLine(output)
    const el = toolBlock({
      summary: `${verb}${path ? " " + path : ""}`,
      body: tool === "read" ? "" : output,
      status,
      failed,
      expanded: failed,
    })
    // Prefix the label with a file glyph.
    const glyph = el.querySelector(".tool-glyph")
    if (glyph && !running && !failed) glyph.textContent = FILE_TOOL_GLYPH[tool] || "•"
    return el
  }

  // bash / shell (and app-server command_execution, which has no tool_name but
  // carries a real command line) — the classic "$ cmd" card.
  const isBash = !tool || tool === "bash" || tool === "shell"
  if (isBash) {
    return toolBlock({
      summary: `$ ${item.command || ""}`.trimEnd(),
      body: output,
      status,
      failed,
      mono: true,
      badge: nonZero ? `exit ${item.exit_code}` : "",
      expanded: failed || nonZero,
    })
  }

  // Any other named tool.
  return toolBlock({
    summary: L.tool(item.command || tool),
    body: output,
    status,
    failed,
    expanded: failed,
  })
}

function firstLine(text) {
  const line = String(text || "").split("\n").find((l) => l.trim())
  return line ? (line.length > 80 ? line.slice(0, 80) + "…" : line.trim()) : ""
}

/** Best-effort file path from a "tool {json}" or "tool path" command string. */
function filePathFromCommand(command, tool) {
  if (!command) return ""
  const rest = command.slice(tool.length).trim()
  if (!rest) return ""
  try {
    const obj = JSON.parse(rest)
    return obj.filePath || obj.path || obj.file || ""
  } catch {
    return rest.length > 80 ? rest.slice(0, 80) + "…" : rest
  }
}

function buildItemEl(item) {
  switch (item.type) {
    case "agent_message":
      return agentBlock(item.text || "", item.citations)
    case "reasoning": {
      const el = document.createElement("div")
      el.className = "line"
      el.appendChild(reasoningBlock(item.text || ""))
      return el
    }
    case "command_execution":
      return commandExecutionBlock(item)
    case "file_change":
      return fileChangeBlock(item)
    case "mcp_tool_call": {
      const argPreview = item.arguments ? summarizeArgs(item.arguments) : ""
      return toolBlock({
        summary: L.tool(`${item.server ? item.server + "/" : ""}${item.tool || ""}${argPreview ? " " + argPreview : ""}`),
        failed: item.status === "failed",
      })
    }
    case "web_search":
      return toolBlock({ summary: L.webSearch(item.query || "") })
    case "plan":
      return planBlock(item.text || "")
    case "todo_list": {
      const todos = (item.items || [])
        .map((t) => `${t.completed ? "☑" : "☐"} ${t.text}`)
        .join("\n")
      return planBlock(todos)
    }
    case "subagent":
      return subagentBlock(item)
    case "collab_agent": {
      const who = (item.agents || []).map((a) => `${a.threadId.slice(0, 6)}:${a.status}`).join(", ")
      return toolBlock({
        summary: `${L.multiAgent(item.tool)}${item.model ? " (" + item.model + ")" : ""}${who ? " — " + who : ""}`,
        body: (item.agents || []).map((a) => a.message).filter(Boolean).join("\n"),
      })
    }
    case "dynamic_tool":
      return toolBlock({
        summary: L.tool(`${item.namespace ? item.namespace + "/" : ""}${item.tool}${item.success === false ? " ✗" : ""}`),
        body: item.arguments ? summarizeArgs(item.arguments) : "",
        failed: item.success === false,
      })
    case "auto_review": {
      const risk = item.riskLevel ? ` [${item.riskLevel}]` : ""
      return metaBlockLine(L.autoReview(`${item.action}${risk}${item.rationale ? " — " + item.rationale : ""}`))
    }
    case "image_generation":
      return imageBlock(item.savedPath, item.revisedPrompt, item.status)
    case "image_view":
      return imageBlock(item.path, "", "completed")
    case "sleep":
      return metaBlockLine(L.waiting(item.durationMs ? Math.round(item.durationMs / 1000) : null))
    case "hook_prompt":
      return item.text ? metaBlockLine(`· hook: ${item.text.slice(0, 120)}`) : null
    case "context_compaction":
      return metaBlockLine(L.compacted)
    case "review_mode":
      return metaBlockLine(item.entered ? L.reviewEnter : L.reviewExit)
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

function metaBlockLine(text) {
  const el = document.createElement("div")
  el.className = "line meta"
  el.textContent = text
  return el
}

function summarizeArgs(args) {
  try {
    const s = typeof args === "string" ? args : JSON.stringify(args)
    return s.length > 60 ? s.slice(0, 60) + "…" : s
  } catch {
    return ""
  }
}

/** Rich diff cell: per-file collapsible unified diff with +/- coloring. */
function fileChangeBlock(item) {
  const changes = item.changes || []
  const totalAdd = changes.reduce((n, c) => n + countDiffLines(c.diff, "+"), 0)
  const totalDel = changes.reduce((n, c) => n + countDiffLines(c.diff, "-"), 0)
  const el = document.createElement("div")
  el.className = "line filechange" + (item.status === "failed" ? " failed" : "")

  const header = document.createElement("div")
  header.className = "tool-header expandable"
  const glyph = document.createElement("span")
  glyph.className = "tool-glyph"
  glyph.textContent = item.status === "failed" ? "✗" : "◆"
  const label = document.createElement("span")
  label.className = "tool-label"
  const stat = totalAdd || totalDel ? `  +${totalAdd} -${totalDel}` : ""
  label.textContent = L.editedFiles(changes.length, stat)
  header.append(glyph, label)
  el.appendChild(header)

  const body = document.createElement("div")
  body.className = "diff-body"
  for (const change of changes) {
    const fileEl = document.createElement("div")
    fileEl.className = "diff-file"
    const name = document.createElement("div")
    name.className = "diff-file-name"
    const mark = change.kind === "add" ? "+ " : change.kind === "delete" ? "- " : "~ "
    name.textContent = mark + change.path
    name.title = L.openInEditor
    name.addEventListener("click", () => {
      vscode.postMessage({ type: "openFile", path: change.path })
    })
    fileEl.appendChild(name)
    if (change.diff && change.diff.trim()) {
      fileEl.appendChild(renderDiff(change.diff))
    }
    body.appendChild(fileEl)
  }
  el.appendChild(body)
  header.addEventListener("click", () => {
    body.hidden = !body.hidden
  })
  return el
}

function countDiffLines(diff, sign) {
  if (!diff) return 0
  return diff.split("\n").filter((l) => l.startsWith(sign) && !l.startsWith(sign + sign)).length
}

function renderDiff(diff) {
  const pre = document.createElement("pre")
  pre.className = "diff"
  for (const raw of diff.split("\n")) {
    const line = document.createElement("span")
    line.className = "diff-line"
    if (raw.startsWith("@@")) line.classList.add("hunk")
    else if (raw.startsWith("+") && !raw.startsWith("+++")) line.classList.add("add")
    else if (raw.startsWith("-") && !raw.startsWith("---")) line.classList.add("del")
    line.textContent = raw + "\n"
    pre.appendChild(line)
  }
  return pre
}

/** Plan / todo checklist: parses "- [ ] / - [x]" markdown into checkable rows. */
function planBlock(text) {
  const el = document.createElement("div")
  el.className = "line plan"
  const title = document.createElement("div")
  title.className = "plan-title"
  title.textContent = L.planTitle
  el.appendChild(title)
  const list = document.createElement("div")
  list.className = "plan-list"
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  for (const raw of lines) {
    const m = raw.match(/^[-*]?\s*\[([ xX✓☑])\]\s*(.*)$/) || raw.match(/^([☑☐])\s*(.*)$/)
    const done = m ? /[xX✓☑]/.test(m[1]) : false
    const label = m ? m[2] : raw.replace(/^[-*]\s*/, "")
    const row = document.createElement("div")
    row.className = "plan-row" + (done ? " done" : "")
    const box = document.createElement("span")
    box.className = "plan-box"
    box.textContent = done ? "☑" : "☐"
    const txt = document.createElement("span")
    txt.textContent = label
    row.append(box, txt)
    list.appendChild(row)
  }
  el.appendChild(list)
  return el
}

/** Inline image (generation result / viewed file) with open-file affordance. */
function imageBlock(path, caption, status) {
  const el = document.createElement("div")
  el.className = "line image-block"
  if (status && status !== "completed") {
    return toolBlock({ summary: L.imageStatus(status === "failed" ? "✗" : "…") })
  }
  if (path) {
    const name = document.createElement("div")
    name.className = "diff-file-name"
    name.textContent = "🖼 " + path
    name.addEventListener("click", () => vscode.postMessage({ type: "openFile", path }))
    el.appendChild(name)
  }
  if (caption) {
    const cap = document.createElement("div")
    cap.className = "subagent-header"
    cap.textContent = caption
    el.appendChild(cap)
  }
  return el.childElementCount ? el : toolBlock({ summary: L.image })
}

/** Subagent card: nested activity from a child thread. */
function subagentBlock(item) {
  const el = document.createElement("div")
  el.className = "line subagent"
  const header = document.createElement("div")
  header.className = "subagent-header"
  const glyph = document.createElement("span")
  glyph.className = "subagent-glyph"
  glyph.textContent = "⟐"
  const label = document.createElement("span")
  const name = (item.agentPath || "subagent").split("/").pop()
  const kindText =
    item.kind === "started" ? L.subStarted : item.kind === "completed" ? L.subCompleted : item.kind || ""
  label.textContent = L.subagent(name, kindText)
  header.append(glyph, label)
  el.appendChild(header)
  return el
}

function renderItem(item) {
  const el = buildItemEl(item)
  if (!el) {
    return
  }
  const key = item.id ? `${turnSeq}:${item.id}` : null
  const existing = key ? itemEls.get(key) : undefined
  if (existing) {
    // Preserve the user's expand/collapse choices across streamed updates.
    const oldOutput = existing.querySelector(".tool-output")
    const newOutput = el.querySelector(".tool-output")
    if (oldOutput && newOutput) {
      newOutput.hidden = oldOutput.hidden
      const chevron = el.querySelector(".tool-chevron")
      if (chevron) chevron.classList.toggle("open", !newOutput.hidden)
    }
    const oldReasoning = existing.querySelector("details.reasoning")
    const newReasoning = el.querySelector("details.reasoning")
    if (oldReasoning && newReasoning) {
      newReasoning.open = oldReasoning.open
    }
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

// ---------- streaming (app-server deltas) ----------

/** itemKey -> streaming DOM handles */
const streams = new Map()

function streamKey(itemId) {
  return `${turnSeq}:${itemId}`
}

function ensureAgentStream(itemId) {
  const key = streamKey(itemId)
  let entry = streams.get(key)
  if (!entry) {
    const el = document.createElement("div")
    el.className = "line agent streaming"
    const textNode = document.createElement("span")
    textNode.className = "stream-text"
    el.appendChild(textNode)
    appendLine(el)
    itemEls.set(key, el)
    entry = { el, textNode }
    streams.set(key, entry)
  }
  return entry
}

function ensureReasoningStream(itemId) {
  const key = streamKey(itemId) + ":r"
  let entry = streams.get(key)
  if (!entry) {
    const el = document.createElement("div")
    el.className = "line"
    const details = reasoningBlock("", false, L.thinkingLive)
    details.classList.add("live")
    el.appendChild(details)
    appendLine(el)
    entry = { el, textNode: details.querySelector(".reasoning-body") }
    streams.set(key, entry)
  }
  return entry
}

function ensureToolOutput(itemId) {
  const key = streamKey(itemId)
  const el = itemEls.get(key)
  if (!el) {
    return null
  }
  let pre = el.querySelector(".tool-output")
  if (!pre) {
    pre = document.createElement("pre")
    pre.className = "tool-output"
    pre.hidden = true
    const header = el.querySelector(".tool-header")
    if (header && !header.classList.contains("expandable")) {
      header.classList.add("expandable")
      header.addEventListener("click", () => {
        pre.hidden = !pre.hidden
      })
    }
    el.appendChild(pre)
  }
  return pre
}

// Batch streamed deltas to one DOM write per (kind,item) per animation frame.
// Token deltas arrive far faster than the display refreshes; applying each one
// synchronously (append + auto-scroll reflow) is what makes streaming feel
// janky. Buffered text is concatenated and flushed on the next frame.
const pendingDeltas = new Map() // "<kind>\u0000<itemId>" -> accumulated text
let deltaFlushScheduled = false

function applyDelta(kind, itemId, text) {
  if (!text) {
    return
  }
  const key = `${kind}\u0000${itemId}`
  pendingDeltas.set(key, (pendingDeltas.get(key) || "") + text)
  if (deltaFlushScheduled) {
    return
  }
  deltaFlushScheduled = true
  requestAnimationFrame(() => {
    deltaFlushScheduled = false
    const batch = [...pendingDeltas]
    pendingDeltas.clear()
    for (const [k, buffered] of batch) {
      const sep = k.indexOf("\u0000")
      applyDeltaNow(k.slice(0, sep), k.slice(sep + 1), buffered)
    }
    pinWorking()
    scrollToBottom()
  })
}

function applyDeltaNow(kind, itemId, text) {
  if (kind === "agent") {
    ensureAgentStream(itemId).textNode.textContent += text
  } else if (kind === "reasoning") {
    ensureReasoningStream(itemId).textNode.textContent += text
  } else if (kind === "cmdOutput") {
    const pre = ensureToolOutput(itemId)
    if (pre) {
      pre.textContent += text
    }
  } else if (kind === "plan") {
    const entry = streams.get(streamKey(itemId) + ":plan") || (() => {
      const line = planBlock("")
      appendLine(line)
      const e = { el: line, raw: "" }
      streams.set(streamKey(itemId) + ":plan", e)
      return e
    })()
    entry.raw += text
    const replaced = planBlock(entry.raw)
    entry.el.replaceWith(replaced)
    entry.el = replaced
  }
}

// ---------- approvals ----------

function approvalCard({ id, kind, detail }) {
  const el = document.createElement("div")
  el.className = "line approval"
  const title = document.createElement("div")
  title.className = "approval-title"
  title.textContent =
    kind === "command" ? L.approveCommand : kind === "fileChange" ? L.approveFileChange : L.approvePermissions
  el.appendChild(title)

  // Show what is actually being approved.
  if (detail) {
    if (kind === "command" && detail.command) {
      const cmd = document.createElement("pre")
      cmd.className = "approval-detail"
      cmd.textContent = `$ ${detail.command}${detail.cwd ? `\n(cwd: ${detail.cwd})` : ""}`
      el.appendChild(cmd)
    } else if (kind === "fileChange" && (detail.files || []).length) {
      const box = document.createElement("div")
      box.className = "approval-detail"
      for (const f of detail.files) {
        const line = document.createElement("div")
        const mark = f.kind === "add" ? "+ " : f.kind === "delete" ? "- " : "~ "
        line.textContent = mark + f.path
        box.appendChild(line)
        if (f.diff) box.appendChild(renderDiff(f.diff))
      }
      el.appendChild(box)
    }
    if (detail.reason) {
      const reason = document.createElement("div")
      reason.className = "approval-reason"
      reason.textContent = detail.reason
      el.appendChild(reason)
    }
  }

  const row = document.createElement("div")
  row.className = "approval-actions"
  const actions = [
    { label: L.allowOnce, decision: "accept", primary: true },
    { label: L.allowSession, decision: "acceptForSession" },
    { label: L.deny, decision: "decline", danger: true },
    { label: L.denyAbort, decision: "cancel", danger: true },
  ]
  for (const action of actions) {
    const button = document.createElement("button")
    button.className =
      "approval-btn" + (action.primary ? " primary" : "") + (action.danger ? " danger" : "")
    button.textContent = action.label
    button.addEventListener("click", () => {
      vscode.postMessage({ type: "approvalReply", id, decision: action.decision })
      settle(action.label)
    })
    row.appendChild(button)
  }
  const settle = (label) => {
    row.remove()
    const done = document.createElement("div")
    done.className = "approval-done"
    done.textContent = label
    el.appendChild(done)
  }
  el.appendChild(row)
  el.dataset.approvalId = id
  el.settle = settle
  appendLine(el)
  return el
}

/** Multiple-choice question from the model's `ask` tool (agent-core). */
function questionCard({ id, question, options }) {
  const el = document.createElement("div")
  el.className = "line approval question"
  const eyebrow = document.createElement("div")
  eyebrow.className = "approval-eyebrow"
  eyebrow.textContent = L.needDecision
  el.appendChild(eyebrow)
  const title = document.createElement("div")
  title.className = "approval-title"
  title.textContent = question || L.pleaseChoose
  el.appendChild(title)

  const row = document.createElement("div")
  row.className = "approval-actions"
  const settle = (label) => {
    row.remove()
    const done = document.createElement("div")
    done.className = "approval-done"
    done.textContent = label ? L.chosen(label) : L.skipped
    el.appendChild(done)
  }
  for (const opt of Array.isArray(options) ? options : []) {
    const button = document.createElement("button")
    button.className = "approval-btn primary"
    button.textContent = opt
    button.addEventListener("click", () => {
      vscode.postMessage({ type: "questionReply", id, answer: opt })
      settle(opt)
    })
    row.appendChild(button)
  }
  const skip = document.createElement("button")
  skip.className = "approval-btn"
  skip.textContent = L.skip
  skip.addEventListener("click", () => {
    vscode.postMessage({ type: "questionReply", id, answer: null })
    settle("")
  })
  row.appendChild(skip)
  el.appendChild(row)
  appendLine(el)
  return el
}

/** Interactive question card (item/tool/requestUserInput). */
function userInputCard({ id, questions }) {
  const el = document.createElement("div")
  el.className = "line approval"
  const answers = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const title = document.createElement("div")
    title.className = "approval-title"
    title.textContent = q.header || q.question || L.question
    el.appendChild(title)
    if (q.question && q.question !== q.header) {
      const sub = document.createElement("div")
      sub.className = "approval-reason"
      sub.textContent = q.question
      el.appendChild(sub)
    }
    answers[i] = ""
    if ((q.options || []).length) {
      const row = document.createElement("div")
      row.className = "approval-actions"
      for (const opt of q.options) {
        const b = document.createElement("button")
        b.className = "approval-btn"
        b.textContent = opt
        b.addEventListener("click", () => {
          answers[i] = opt
          ;[...row.querySelectorAll("button")].forEach((x) => x.classList.remove("primary"))
          b.classList.add("primary")
        })
        row.appendChild(b)
      }
      el.appendChild(row)
    } else {
      const input = document.createElement("input")
      input.className = "approval-input"
      input.type = q.isSecret ? "password" : "text"
      input.addEventListener("input", () => (answers[i] = input.value))
      el.appendChild(input)
    }
  }
  const submit = document.createElement("button")
  submit.className = "approval-btn primary"
  submit.textContent = L.submit
  submit.addEventListener("click", () => {
    vscode.postMessage({ type: "userInputReply", id, answers })
    el.querySelectorAll("button, input").forEach((x) => (x.disabled = true))
    const done = document.createElement("div")
    done.className = "approval-done"
    done.textContent = L.answered
    el.appendChild(done)
  })
  el.appendChild(submit)
  appendLine(el)
  return el
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
    label.textContent = L.thinkingLive
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
  if (!on) {
    // Settle any reasoning block still in its live-shimmer state — agent-core
    // reasoning items never get a final upsert, so the turn's end is the cue.
    for (const d of messagesEl.querySelectorAll("details.reasoning.live")) {
      d.classList.remove("live")
    }
  }
  // While a turn runs, Enter / this button STEERS (folds text into the running
  // turn); the separate stop button interrupts.
  sendEl.textContent = on ? L.steerBtn : "↑"
  sendEl.title = on ? L.steerTitle : L.sendTitle
  sendEl.classList.toggle("steer-mode", on)
  if (stopEl) {
    stopEl.hidden = !on
  }
  updateComposerHint(on)
}

function updateComposerHint(on) {
  const hint = $("composer-hint")
  if (hint) {
    hint.textContent = on ? L.hintSteering : L.hintIdle
  }
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
  if (!messagesEl.childElementCount) {
    const empty = document.createElement("div")
    empty.className = "empty-state"
    empty.textContent = L.emptyState
    messagesEl.appendChild(empty)
    const clear = () => empty.remove()
    inputEl.addEventListener("keydown", clear, { once: true })
  }
}

// ---------- login ----------

$("login-unieai").addEventListener("click", () => startLogin(undefined))
$("login-company").addEventListener("click", () => {
  const url = $("company-url").value.trim()
  if (!url) {
    showLoginError(L.enterCompanyUrl)
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
  text.textContent = L.noModels
  const link = document.createElement("a")
  link.textContent = L.addModels
  link.addEventListener("click", () => {
    vscode.postMessage({ type: "openStudioModels", url: studioModelsUrl })
  })
  const tail = document.createElement("span")
  tail.textContent = L.thenRelogin
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
      errorLine((event.error && event.error.message) || L.turnFailed)
      break
    case "error":
      errorLine(event.message || "error")
      break
  }
}

// ---------- composer ----------

let steerSeq = 0

function send() {
  const text = inputEl.value.trim()
  // Mid-turn: fold the text into the RUNNING turn as a steer, rather than
  // queuing a brand-new turn. The dedicated stop button handles interrupts.
  if (running) {
    if (!text) {
      return
    }
    const id = `steer-${++steerSeq}`
    const el = steerLine(text)
    el.dataset.steerId = id
    inputEl.value = ""
    inputEl.style.height = "auto"
    slashMenuEl.hidden = true
    vscode.postMessage({ type: "steer", text, id })
    return
  }
  if (!text) {
    return
  }
  turnSeq += 1
  userLine(text)
  inputEl.value = ""
  inputEl.style.height = "auto"
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
  { cmd: "/new", desc: () => L.slashNew, run: () => vscode.postMessage({ type: "newChat" }) },
  { cmd: "/history", desc: () => L.slashHistory, run: () => $("history-btn").click() },
  { cmd: "/model", desc: () => L.slashModel, run: () => modelEl.focus() },
  { cmd: "/plan", desc: () => L.slashPlan, run: () => { modeEl.value = "plan"; metaLine(L.switchedPlan) } },
  { cmd: "/exec", desc: () => L.slashExec, run: () => { modeEl.value = "exec"; metaLine(L.switchedExec) } },
  {
    cmd: "/web",
    desc: () => L.slashWeb,
    run: () => {
      webEl.value = webEl.value === "on" ? "off" : "on"
      webEl.dispatchEvent(new Event("change"))
      metaLine(webEl.value === "on" ? L.metaWebOn : L.metaWebOff)
    },
  },
  { cmd: "/perm", desc: () => L.slashPerm, run: () => permEl.focus() },
  {
    cmd: "/goal",
    desc: () => L.slashGoal,
    run: () => {
      goalMode = goalMode === false ? "review" : goalMode === "review" ? "gate" : false
      vscode.postMessage({ type: "setGoalMode", value: goalMode })
      metaLine(
        goalMode === "review" ? L.goalReview : goalMode === "gate" ? L.goalGate : L.goalOff,
      )
    },
  },
  { cmd: "/rewind", desc: () => L.slashRewind, run: () => vscode.postMessage({ type: "listCheckpoints" }) },
  { cmd: "/retry", desc: () => L.slashRetry, run: () => vscode.postMessage({ type: "retry" }) },
  { cmd: "/engine", desc: () => L.slashEngine, run: () => vscode.postMessage({ type: "openSetting", key: "unieai-code.engine" }) },
  { cmd: "/stop", desc: () => L.slashStop, run: () => vscode.postMessage({ type: "stop" }) },
  { cmd: "/logout", desc: () => L.slashLogout, run: () => vscode.postMessage({ type: "logout" }) },
  { cmd: "/terminal", desc: () => L.slashTerminal, run: () => vscode.postMessage({ type: "openTerminal" }) },
  {
    cmd: "/help",
    desc: () => L.slashHelp,
    run: () => metaLine(L.commandsList(SLASH_COMMANDS.map((c) => c.cmd).join("  "))),
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
    desc.textContent = candidate.desc()
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

// ---------- @-file mentions (opencode-style) ----------
// Typing "@partial" pops a workspace-file picker; Enter/Tab inserts the
// relative path. The file list is fetched once per panel session, lazily.

let workspaceFiles = null // null = not fetched; [] = fetched (possibly empty)
let mentionSelected = 0

/** The trailing "@query" token before the caret, or null. */
function mentionQuery() {
  const upToCaret = inputEl.value.slice(0, inputEl.selectionStart ?? inputEl.value.length)
  const m = upToCaret.match(/(^|[\s([{'"`])@([\w./~-]*)$/)
  return m ? m[2] : null
}

function mentionCandidates() {
  const q = mentionQuery()
  if (q === null || !Array.isArray(workspaceFiles)) {
    return []
  }
  const needle = q.toLowerCase()
  const scored = []
  for (const f of workspaceFiles) {
    const lower = f.toLowerCase()
    const idx = lower.indexOf(needle)
    if (needle && idx === -1) continue
    // Rank basename hits above directory hits, shorter paths first.
    const base = lower.slice(lower.lastIndexOf("/") + 1)
    scored.push({ f, score: (base.includes(needle) ? 0 : 1000) + idx + f.length / 500 })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, 12).map((s) => s.f)
}

function renderMentionMenu() {
  const candidates = mentionCandidates()
  if (!candidates.length) {
    if (mentionQuery() === null) return false
    slashMenuEl.hidden = true
    return true // in mention context, just nothing to show
  }
  mentionSelected = Math.min(mentionSelected, candidates.length - 1)
  slashMenuEl.innerHTML = ""
  candidates.forEach((file, index) => {
    const el = document.createElement("div")
    el.className = "slash-item" + (index === mentionSelected ? " selected" : "")
    const cmd = document.createElement("span")
    cmd.className = "slash-cmd"
    cmd.textContent = file.slice(file.lastIndexOf("/") + 1)
    const desc = document.createElement("span")
    desc.className = "slash-desc"
    desc.textContent = file
    el.append(cmd, desc)
    el.addEventListener("mousedown", (e) => {
      e.preventDefault()
      insertMention(file)
    })
    slashMenuEl.appendChild(el)
  })
  slashMenuEl.hidden = false
  return true
}

function insertMention(file) {
  const caret = inputEl.selectionStart ?? inputEl.value.length
  const before = inputEl.value.slice(0, caret).replace(/@[\w./~-]*$/, file + " ")
  inputEl.value = before + inputEl.value.slice(caret)
  slashMenuEl.hidden = true
  mentionSelected = 0
  inputEl.focus()
  inputEl.setSelectionRange(before.length, before.length)
}

inputEl.addEventListener("input", () => {
  slashSelected = 0
  mentionSelected = 0
  if (mentionQuery() !== null) {
    if (workspaceFiles === null) {
      workspaceFiles = [] // request once; menu fills when the reply lands
      vscode.postMessage({ type: "listFiles" })
    }
    renderMentionMenu()
  } else {
    renderSlashMenu()
  }
  // Auto-grow the composer with content (capped by CSS max-height).
  inputEl.style.height = "auto"
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`
})

modelEl.addEventListener("change", () => {
  vscode.postMessage({ type: "setModel", model: modelEl.value })
})

webEl.addEventListener("change", () => {
  vscode.postMessage({ type: "setWebAccess", value: webEl.value === "on" })
})

sendEl.addEventListener("click", send)
if (stopEl) {
  stopEl.addEventListener("click", () => {
    if (running) {
      vscode.postMessage({ type: "stop" })
    }
  })
}
inputEl.addEventListener("keydown", (e) => {
  // IME composition: Enter confirms the composition, not the message.
  if (e.isComposing || e.keyCode === 229) {
    return
  }
  // @-mention menu takes precedence when a mention is being typed.
  const mentions = mentionCandidates()
  if (!slashMenuEl.hidden && mentions.length && mentionQuery() !== null) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      mentionSelected = (mentionSelected + 1) % mentions.length
      renderMentionMenu()
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      mentionSelected = (mentionSelected - 1 + mentions.length) % mentions.length
      renderMentionMenu()
      return
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      insertMention(mentions[mentionSelected])
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      slashMenuEl.hidden = true
      return
    }
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
  historyList.innerHTML = `<div class="line meta">${L.loading}</div>`
  historyOverlay.hidden = false
  vscode.postMessage({ type: "listSessions" })
})
$("history-close").addEventListener("click", () => {
  historyOverlay.hidden = true
})
historyOverlay.addEventListener("click", (e) => {
  if (e.target === historyOverlay) {
    historyOverlay.hidden = true
  }
})
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !historyOverlay.hidden) {
    historyOverlay.hidden = true
  }
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
    historyList.innerHTML = `<div class="line meta">${L.noSessions}</div>`
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
      L = I18N[message.locale] || I18N.en
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
      showLoginError(message.message || L.loginFailed)
      break
    case "event":
      handleEvent(message.event)
      break
    case "itemUpsert": {
      // Completed items re-render fully (markdown, think blocks); drop any
      // streaming placeholder for the same item first — including deltas still
      // buffered for it (rAF batch), which would otherwise flush AFTER the
      // re-render and duplicate the tail into a fresh stray element.
      streams.delete(streamKey(message.item.id))
      streams.delete(streamKey(message.item.id) + ":r")
      streams.delete(streamKey(message.item.id) + ":plan")
      for (const kind of ["agent", "reasoning", "cmdOutput", "plan"]) {
        pendingDeltas.delete(`${kind}\u0000${message.item.id}`)
      }
      renderItem(message.item)
      break
    }
    case "turnDelta":
      applyDelta(message.kind, message.itemKey, message.text)
      break
    case "steerAck": {
      // The host reports whether the running turn actually received the steer.
      const el = message.id
        ? messagesEl.querySelector(`[data-steer-id="${message.id}"]`)
        : null
      if (el) {
        if (message.delivered) {
          el.classList.add("delivered")
        } else {
          // No turn was in flight (it just finished, or app-server engine has
          // no steer seam) — mark the line and hand the text back to the
          // composer so one Enter resends it as a normal message.
          el.classList.add("undelivered")
          const note = document.createElement("span")
          note.className = "steer-note"
          note.textContent = L.steerUndelivered
          el.appendChild(note)
          const original = el.querySelector(".steer-text")?.textContent || ""
          if (original && !inputEl.value.trim()) {
            inputEl.value = original
            inputEl.focus()
          }
        }
      }
      break
    }
    case "questionRequest":
      questionCard({ id: message.id, question: message.question, options: message.options })
      break
    case "approvalRequest":
      approvalCard({ id: message.id, kind: message.kind, detail: message.detail })
      break
    case "userInputRequest":
      userInputCard({ id: message.id, questions: message.questions || [] })
      break
    case "tokenUsage": {
      const meter = $("token-meter")
      if (meter) meter.textContent = L.tokenMeter((message.total / 1000).toFixed(1))
      break
    }
    case "approvalResolved": {
      const card = messagesEl.querySelector(`[data-approval-id="${message.id}"]`)
      if (card && card.settle) {
        card.settle(message.decision)
      }
      break
    }
    case "turnState":
      if (message.state === "interrupted") {
        setRunning(false)
        metaLine(L.interrupted)
      } else if (message.state === "failed") {
        setRunning(false)
        const el = document.createElement("div")
        el.className = "line error"
        el.textContent = L.turnFailed
        if (message.retryable) {
          const retry = document.createElement("button")
          retry.className = "approval-btn"
          retry.textContent = L.retry
          retry.addEventListener("click", () => {
            retry.disabled = true
            setRunning(true)
            vscode.postMessage({ type: "retry" })
          })
          el.appendChild(document.createTextNode(" "))
          el.appendChild(retry)
        }
        appendLine(el)
      } else if (message.state === "idle") {
        setRunning(false)
      }
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
      pendingDeltas.clear()
      turnSeq += 1
      setRunning(false)
      break
    case "sessions":
      renderSessions(message.sessions || [])
      break
    case "files":
      workspaceFiles = Array.isArray(message.files) ? message.files : []
      if (mentionQuery() !== null) renderMentionMenu()
      break
    case "checkpoints": {
      // /rewind — read-only list of per-turn snapshots, rendered as a card.
      const cps = Array.isArray(message.checkpoints) ? message.checkpoints : []
      const el = document.createElement("div")
      el.className = "line plan"
      const title = document.createElement("div")
      title.className = "plan-title"
      title.textContent = L.rewindTitle
      el.appendChild(title)
      if (!cps.length) {
        const empty = document.createElement("div")
        empty.className = "plan-row"
        empty.textContent = L.rewindEmpty
        el.appendChild(empty)
      } else {
        const list = document.createElement("div")
        list.className = "plan-list"
        for (const cp of cps) {
          const row = document.createElement("div")
          row.className = "plan-row"
          const time = cp.at ? new Date(cp.at).toLocaleTimeString() : "—"
          const head = document.createElement("span")
          head.textContent = L.rewindPoint(cp.index, time, (cp.files || []).length)
          row.appendChild(head)
          list.appendChild(row)
          for (const f of (cp.files || []).slice(0, 8)) {
            const fr = document.createElement("div")
            fr.className = "plan-row done"
            fr.textContent = `  ${f.status} ${f.path}`
            list.appendChild(fr)
          }
        }
        el.appendChild(list)
      }
      appendLine(el)
      break
    }
    case "sessionLoaded": {
      messagesEl.innerHTML = ""
      itemEls.clear()
      pendingDeltas.clear()
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
      metaLine(L.sessionLoadedMeta)
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
