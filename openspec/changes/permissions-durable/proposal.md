# Proposal: permissions-durable

**Target:** unieai-code（核准/權限層）· 來源：opencode `permission.ts`、`permission/saved.ts`、`permission/arity.ts`

## Why

現行核准是一次性卡片。opencode 的權限模型有幾個明顯更好用的行為：**每專案持久化規則**、**拒絕級聯**、**拒絕訊息變成模型可行動的修正**、以及 bash 指令的 **arity 歸併**（讓 `git log -n5` 與 `git log` 共用一條規則）。這些直接減少反覆核准的摩擦，並讓「拒絕」變成有建設性的回饋而非死路。

## What Changes

- **每專案持久化規則**：核准時可選「always」，持久化成 action+resource 樣式規則存於專案層；之後自動放行已涵蓋的待審請求。
- **拒絕級聯**：拒絕同一 session 的一個待審請求時，級聯拒絕該 session 其他待審請求。
- **拒絕即修正**：帶訊息的拒絕變成模型可讀的 `CorrectedError{feedback}`——模型可據以調整，而非硬停。
- **bash arity 歸併**：以 tree-sitter + 一張 arity 表把 bash 指令歸併，使同一指令的不同旗標共用一條已存規則。
- `save` 語意隨工具不同：edit/write 存 `["*"]`，bash 存歸併後的指令樣式。

## Capabilities

### New Capabilities
- `durable-permissions`：每專案持久化規則與自動放行、拒絕級聯、拒絕即修正回饋、bash arity 歸併。

## Impact

- **落點：unieai-code**：核准引擎（每專案規則儲存、級聯、修正回饋）在產品層；bash arity 歸併是 coding 專屬。
- 與 agent-core：權限「原語」（要不要問、如何阻塞）屬迴圈層；本 change 聚焦「產品如何記住與呈現規則」。
- 風險：持久化規則的樣式比對必須保守（寧可多問，不可誤放行危險指令）。
