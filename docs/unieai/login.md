# 登入

UnieAI Code 用 UnieAI Studio 的 **device-code 流程**登入，憑證存進
`~/.unieai/unieai.json`（TUI、CLI、agent-core、VS Code 面板共用）。

## CLI

```bash
# 公有雲
unieai login

# 公司 / 地端 Studio
unieai login --studio-url https://studio.demo.unieai.com

# 明確指定 gateway（地端，Studio 沒回傳可達 URL 時）
unieai login --studio-url https://studio.corp.com --gateway-url https://gw.corp.com/v1

# 改用 OpenAI ChatGPT 登入（保留，非預設）
unieai login --chatgpt

unieai logout      # revoke + 刪除 unieai.json
```

流程：要 device code → 顯示連結與代碼、自動開瀏覽器 → 你在 Studio 確認 →
交換 token、抓 gateway 憑證與模型清單 → 寫入 `unieai.json`。

## TUI onboarding

第一次啟動（`~/.unieai` 無憑證）會走互動式登入：
1. **Sign in with UnieAI Studio**（公有雲）
2. **Sign in with your company's UnieAI Studio**（輸入公司/地端 URL）

（ChatGPT 路徑不在選單，僅 `unieai login --chatgpt`）

## VS Code 面板

側欄面板未登入時顯示登入畫面（同兩個選項），device code 直接在面板內顯示、
自動開瀏覽器，確認後進入聊天。也可用 `/logout`。

## unieai.json 內容

```jsonc
{
  "studio_url": "https://studio.unieai.com",
  "access_token": "…",        // Studio API 用，1h
  "refresh_token": "…",       // 365d
  "gateway_base_url": "https://api.unieai.com/v1",
  "gateway_api_key": "…",     // 推論 bearer（不是 OAuth token）
  "available_models": [ { "id": "Qwen3.6-35B-A3B", "name": "…" }, … ]
}
```

- **推論用 gateway runtime key，不是 OAuth token**——token 只用於 Studio API。
- gateway URL 解析優先序：`UNIEAI_GATEWAY_URL` env > 登入時輸入 > Studio config
  的公開 URL > 從 `studio.` 主機推導 `api.`（地端不會誤連公有雲）。

## 環境變數覆蓋

| 變數 | 作用 |
|---|---|
| `UNIEAI_HOME` | 憑證/session 目錄（預設 `~/.unieai`；`CODEX_HOME` 相容） |
| `UNIEAI_API_KEY` | 直接給 gateway key，跳過登入畫面 |
| `UNIEAI_GATEWAY_URL` | 覆蓋 gateway base URL |
| `UNIEAI_STUDIO_URL` | 預設 Studio URL |
