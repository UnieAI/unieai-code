<!-- Copyright (c) 2026 UnieAI. All rights reserved. -->

# 用量與計費 API（Studio ↔ UnieAI Code 契約）

UnieAI 訂閱方案比照 Claude Code / Codex。每個請求的扣款順序：

1. **grants**（贈送／促銷點數，最早到期的先扣）：一律最先扣，不受 Extra usage 影響，
   免得免費額度沒用完就過期；
2. **方案額度**（5 小時與每週兩個視窗）；
3. 視窗用完之後怎麼辦，由使用者自己決定的 **Extra usage（額外用量）** 開關控制：

| 視窗用完時 | 行為 |
|---|---|
| Extra usage **關**（預設） | gateway 擋下請求，回 `429 plan_limit_reached`，等視窗重置 |
| Extra usage **開** | 改扣錢包（仍受每月上限約束） |

沒有訂閱方案（`plan: null`）的帳號維持現況：每個請求直接扣錢包（pay-as-you-go），
Extra usage 開關對它沒有意義。

本文件是 Studio 要實作的介面。CLI 端（`codex-rs/login/src/unieai.rs`、TUI `/usage`）
已照這份契約實作，並用假 Studio 測過。

## 共通規則

- **認證**：`Authorization: Bearer <access_token>`，即 device-code 登入取得、存在
  `~/.unieai/unieai.json` 的 `access_token`（與 `/api/config`、`/api/wallet/me` 同一種
  token）。CLI 在 token 快到期時會先用 refresh token 換新。
- **組織**：登入有選組織時，CLI 會帶 `x-org-id: <active_org_id>`，和 `/api/config` 一樣。
  帳單主體（個人或群組錢包）請比照 `/api/wallet/me` 的 `resolveBillingContext`。
- **金額**：`*MicroUsd` 是整數（1 USD = 1,000,000）；`*Usd` 是數字（可有小數），格式同
  `/api/wallet/me`。
- **時間**：ISO 8601 字串（UTC，例如 `2026-10-20T15:00:00.000Z`）。CLI 會轉成使用者的本地時間顯示。
- **回應外層**：CLI 兩種都接受：直接回物件，或 Studio 慣用的 `{"request_id": "...", "data": {...}}`。
- **錯誤格式**：`{"error": {"code": "...", "message": "..."}}`，與 Studio 其他路由相同。

## `GET {studio_url}/api/usage/me`

目前帳號的方案、兩個視窗的用量、Extra usage 開關、grants 與錢包。

### 200 回應

```json
{
  "plan": { "key": "pro", "name": "Pro", "status": "active" },
  "windows": {
    "fiveHour": {
      "usedMicroUsd": 3100000,
      "limitMicroUsd": 5000000,
      "resetsAt": "2026-10-20T15:00:00.000Z",
      "windowMinutes": 300
    },
    "week": {
      "usedMicroUsd": 12000000,
      "limitMicroUsd": 40000000,
      "resetsAt": "2026-10-26T00:00:00.000Z",
      "windowMinutes": 10080
    }
  },
  "extraUsage": { "enabled": false },
  "grants": [
    { "label": "Welcome credit", "remainingMicroUsd": 2000000, "expiresAt": "2026-11-30T00:00:00.000Z" }
  ],
  "wallet": {
    "availableMicroUsd": 18250000,
    "availableUsd": 18.25,
    "monthlyLimitUsd": 50,
    "monthlySpentUsd": 7.5,
    "monthlyRemainingUsd": 42.5,
    "periodEnd": "2026-11-01T00:00:00.000Z"
  },
  "links": {
    "manage": "https://agent.unieai.com/settings/subscription",
    "topUp": "https://studio.unieai.com/plan"
  }
}
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `plan` | object \| null | 沒訂閱方案時為 `null` |
| `plan.key` | string | 方案代碼（`free`、`pro`…） |
| `plan.name` | string | 顯示名稱 |
| `plan.status` | string | `active`、`past_due`、`canceled`… CLI 原樣顯示非 `active` 的狀態 |
| `windows.fiveHour` / `windows.week` | object \| null | 方案沒有該視窗時為 `null` |
| `…usedMicroUsd` | int | 這個視窗已用的額度 |
| `…limitMicroUsd` | int \| null | 視窗上限；`null` = 無上限 |
| `…resetsAt` | string \| null | 視窗下次重置時間 |
| `…windowMinutes` | int | 選填；省略時 CLI 依欄位當成 300 / 10080 |
| `extraUsage.enabled` | bool | 視窗用完後是否改扣 API 點數。省略視為 `false` |
| `grants[]` | array | 贈送／促銷點數，可為空陣列 |
| `grants[].label` | string | 顯示名稱 |
| `grants[].remainingMicroUsd` | int | 剩餘額度 |
| `grants[].expiresAt` | string \| null | 到期時間；`null` = 不過期 |
| `wallet` | object \| null | 欄位與 `/api/wallet/me` 的同名欄位相同 |
| `wallet.monthlyLimitUsd` | number \| null | 使用者自設的每月錢包花費上限；`null` = 不設限 |
| `wallet.monthlyRemainingUsd` | number \| null | 選填；省略時 CLI 用 limit − spent 算 |
| `links.manage` | string | 管理方案的頁面 |
| `links.topUp` | string | 儲值頁面；省略時 CLI 用 `{studio_url}/plan` |

百分比由 CLI 算：`used / limit`，上限為 `null` 時不顯示長條。

### 其他狀態碼

| 狀態 | CLI 行為 |
|---|---|
| 401 | 顯示「Studio 登入已失效，請重新 `unieai login`」 |
| **404** | **視為「這個 Studio 還不支援方案用量」，不是錯誤**：/usage 顯示 "Plan usage isn't available from this Studio yet"，再退回 `GET /api/wallet/me` 顯示錢包 |
| 其他 | /usage 顯示錯誤訊息與重試 |

## `POST {studio_url}/api/usage/extra-usage`

開／關 Extra usage。認證同上。

```json
{ "enabled": true }
```

- **200**：回傳更新後、與 `GET /api/usage/me` 同格式的完整物件。
- **403** `{"error":{"code":"forbidden","message":"..."}}`：例如群組成員沒有權限改群組設定。CLI 顯示 `message`。
- **409** `{"error":{"code":"no_plan","message":"..."}}`：沒有訂閱方案時不能開。CLI 顯示 `message`。

開啟時 CLI 會先跳確認：「視窗用完後，請求會改扣錢包，仍受錢包每月上限約束；
grants 一律在方案額度之前先扣」。關閉不需確認。

開關的生效範圍與錢包相同（個人或群組帳單主體）。請記稽核紀錄（比照
`user_wallet.monthly_limit_set`）。

## Gateway 錯誤碼

inference 請求（`/v1/responses`、`/v1/chat/completions`）被計費擋下時回以下錯誤。
CLI 依 `error.code` 判斷，**不看 message 字串**。

### 429 `plan_limit_reached`

視窗用完且 Extra usage 關閉。

```json
{
  "error": {
    "code": "plan_limit_reached",
    "message": "5-hour plan limit reached",
    "window": "fiveHour",
    "resetsAt": "2026-10-20T15:00:00.000Z"
  }
}
```

- `window`：`"fiveHour"` 或 `"week"`（兩個都用完時給較晚重置的那個）。
- `resetsAt`：該視窗重置時間。也接受放在 `error.details.resetsAt`。
- 建議同時帶 `Retry-After`（秒）。
- **CLI 不會自動重試這個 429**（一般 429 會退避重試）。顯示：
  > You've reached your 5-hour plan limit. It resets at 3:00 PM. Turn on extra usage in /usage to keep going on API credits.

### 402 `insufficient_balance`

要扣錢包（無方案，或 Extra usage 開啟且額度用完）但錢包沒錢。

```json
{ "error": { "code": "insufficient_balance", "message": "..." } }
```

CLI 顯示：
> Your UnieAI wallet is out of credits. Top up at {studio_url}/plan to continue.

### 402 `wallet_monthly_limit_reached`

錢包有錢，但本月花費已達使用者自設的上限（現有 `assertWalletSpendWithinMonthlyLimit`）。
`error.details.periodEnd` 選填。

CLI 顯示：
> You've reached your monthly wallet spending limit. Raise it at {studio_url}/plan, or wait until it resets on Nov 1.

## 選填：rate-limit 回應標頭

gateway 若在每個 inference 回應帶上 codex 格式的標頭，codex 引擎會即時更新 `/status`
與狀態列，不必等 CLI 每回合輪詢 `/api/usage/me`：

| 標頭 | 值 |
|---|---|
| `x-codex-primary-used-percent` | 5 小時視窗已用百分比（0–100，可有小數） |
| `x-codex-primary-window-minutes` | `300` |
| `x-codex-primary-reset-at` | 重置時間，Unix 秒 |
| `x-codex-secondary-used-percent` | 每週視窗已用百分比 |
| `x-codex-secondary-window-minutes` | `10080` |
| `x-codex-secondary-reset-at` | Unix 秒 |
| `x-codex-credits-has-credits` | `true` / `false`：Extra usage 開且錢包或 grants 有餘額 |
| `x-codex-credits-unlimited` | `false` |
| `x-codex-credits-balance` | 錢包餘額（USD 字串，例如 `"18.25"`） |

標頭和 `/api/usage/me` 的數字是同一份資料的兩種讀法，CLI 以較新的為準，不會相加。

## CLI 怎麼用這些介面

- **`/usage`**（Studio 登入）：先顯示 Loading，再顯示方案名稱、5h／每週長條（% 已用、
  幾點重置）、Extra usage 開關、每個 grant 與到期日、錢包餘額與每月上限／已花／剩餘，
  以及「Manage plan」「Top up credits」兩個動作（開 `links.manage`、`links.topUp`）。
- **每回合結束後**（最多每 60 秒一次）抓一次 `/api/usage/me`，轉成 RateLimitSnapshot
  （limit id `codex`，primary = 5h，secondary = week），餵給 `/status` 與狀態列的
  FiveHourLimit / WeeklyLimit。codex 與 uac 兩個引擎都適用。
- 視窗跨過 100% 時提示一次：Extra usage 開且有點數 → "Plan allowance used up — now using
  API credits"；Extra usage 關 → "Plan limit reached, resets at …"。

## Studio 實作檢查清單

- [ ] `GET /api/usage/me`：device token（與 `/api/wallet/me` 相同的 `authenticateDeviceAccessToken`），回上面的格式
- [ ] `windows.*` 由現有 `user-plan-quotas.mjs` 的配額資料算出 used／limit／resetsAt
- [ ] `extraUsage.enabled` 存在帳單主體上（個人／群組），預設 `false`
- [ ] `POST /api/usage/extra-usage`：寫入開關、記稽核、回完整 usage 物件；無方案回 409、無權限回 403
- [ ] 扣款順序：grants → 方案視窗 → （Extra usage 開）錢包；Extra usage 關且視窗用完 → 429 `plan_limit_reached`（含 `window`、`resetsAt`，建議帶 `Retry-After`）
- [ ] 錢包空 → 402 `insufficient_balance`；超過每月上限 → 402 `wallet_monthly_limit_reached`（已存在，確認 gateway 原樣轉出 `error.code`）
- [ ] 錯誤一律走 `{"error":{"code":...}}`，`/v1/responses` 與 `/v1/chat/completions` 一致
- [ ] （選填）inference 回應帶 `x-codex-*` rate-limit 標頭
- [ ] `links.manage`、`links.topUp` 依部署（公有雲／地端）給正確網址
