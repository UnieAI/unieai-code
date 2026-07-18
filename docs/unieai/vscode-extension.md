# VS Code 擴充

側欄聊天面板，位於 `sdks/vscode/`。可切換兩個後端引擎（codex app-server 或
in-process 的 unieai-agent-core），兩者餵同一套渲染。

## 安裝（開發版）

```bash
cd sdks/vscode
npm install
node esbuild.js --production
npx @vscode/vsce package --no-dependencies --skip-license -o unieai-code.vsix
code --install-extension ./unieai-code.vsix --force
```

安裝後在設定填 `unieai-code.executablePath` 指向已 build 的 `unieai` binary
（沒裝進 PATH 時）。重新載入視窗，點左側 activity bar 的 UnieAI Code 圖示。

## 設定

| key | 預設 | 說明 |
|---|---|---|
| `unieai-code.executablePath` | `unieai` | `unieai` binary 路徑 |
| `unieai-code.engine` | `app-server` | 後端引擎：`app-server`（codex Rust）或 `agent-core`（共用 JS 迴圈） |
| `unieai-code.sandboxMode` | `workspace-write` | 回合的 sandbox 模式 |

## 功能

- **登入畫面**（未登入時）：UnieAI Studio / 公司 Studio，device flow 面板內完成
- **對話**：串流回覆、markdown 渲染、思考折疊（`<think>` 與 reasoning 通道）
- **工具卡**：`$ 指令`（exit code、輸出折疊）、彩色 diff（點檔名開編輯器）、
  計畫/todo 清單、subagent 巢狀卡、MCP、圖片、記憶引用註腳
- **互動核准**（app-server 引擎）：指令/改檔核准卡（允許一次 / 本次對話 / 拒絕 /
  拒絕並中斷），面板隱藏時走 VS Code 通知
- **輸入框**：模式（執行/規劃）、權限、上網、模型膠囊；圓形送出（執行中變停止）
- **Slash**：`/new` `/history` `/model` `/engine` `/stop` `/logout` `/terminal`
- **歷史 session**：列出、載入續聊（app-server 讀 rollout；agent-core 讀 agent-sessions）
- **降級**：app-server 掛掉自動退回 exec 模式

## 兩個引擎的差異（面板內）

| | `app-server`（預設） | `agent-core` |
|---|---|---|
| 後端 | codex Rust app-server（JSON-RPC 子進程） | in-process JS 迴圈（esbuild 打包 agent-runtime） |
| 互動核准 | ✅ 完整 | 核准走工具層（sandbox 拒絕才問） |
| 串流粒度 | 協定原生 delta | 逐字 + 回合結束 markdown 化 |
| 與 Studio 共用引擎 | ❌ | ✅ |

## 兩層架構

```
extension.ts (host)          media/chat.js (webview)
  ├─ AppServerClient  ──┐
  ├─ AgentCoreBackend ──┼─ postMessage（統一協定）──▶ 渲染
  └─ exec fallback    ──┘
```
`unieai-code.engine` 只切換 host 的資料來源；webview 渲染完全共用。
