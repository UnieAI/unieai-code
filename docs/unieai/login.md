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

# 自架模型伺服器（不需要 UnieAI 帳號，見下方「自架模型伺服器」）
unieai login --self-hosted http://localhost:11434

unieai logout      # revoke + 刪除 unieai.json
```

流程：要 device code → 顯示連結與代碼、自動開瀏覽器 → 你在 Studio 確認 →
交換 token、抓 gateway 憑證與模型清單 → 寫入 `unieai.json`。

## TUI onboarding

第一次啟動（`~/.unieai` 無憑證）會走互動式登入：
1. **Sign in with UnieAI Studio**（公有雲）
2. **Sign in with your company's UnieAI Studio**（輸入公司/地端 URL）
3. **Sign in with UnieAI Rabi**
4. **Use a self-hosted model server (vLLM, Ollama, LM Studio, …)**（見下方）

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

## 自架模型伺服器（地端模型）

自己部署在自己機器（或內網另一台）的 OpenAI 相容伺服器——vLLM、SGLang、TGI、
llama.cpp server、Ollama、LM Studio……——可以直接接上，**不需要 Studio 或 Rabi
帳號**。只有自架伺服器也能開 TUI 聊天；同時有 Studio 登入時，兩邊的模型都會出現在
`/model`，自架模型的說明欄標 `Self-hosted: <名稱>`，Studio 模型標 `UnieAI Studio`。

### 新增

```bash
# 本機 Ollama（沒寫 scheme 預設 http://，沒寫路徑補 /v1）
unieai login --self-hosted localhost:11434

# 另一台的 vLLM，key 存進 UnieAI home（從 stdin 讀，不會出現在 shell history）
printenv VLLM_API_KEY | unieai login --self-hosted http://gpu-box:8000/v1 --name gpu --with-api-key

# key 不存檔，每次使用時從環境變數讀
unieai login --self-hosted https://llm.corp.example/v1 --name corp --api-key-env CORP_LLM_KEY

# 伺服器不列 /models，或只想用其中幾個：手動指定模型、context window、vision
unieai login --self-hosted http://box:8080/v1 --model my-model --context-window 65536 --vision
```

| 參數 | 作用 |
|---|---|
| `--self-hosted <URL>` | 伺服器的 OpenAI 相容 base URL（通常以 `/v1` 結尾） |
| `--name <名稱>` | provider id（小寫英數、`-`、`_`）；預設取主機名，本機為 `local` |
| `--with-api-key` | 從 stdin 讀 API key，存進 `unieai-self-hosted.json`（0600） |
| `--api-key-env <VAR>` | 只記環境變數名稱，使用時才讀 |
| `--model <ID>` | 手動指定模型（可重複），取代 `GET /models` 的結果 |
| `--context-window <N>` | 模型的 context window；未知時保守預設 32768 |
| `--vision` | 模型可以看圖 |

新增時會先打 `GET <URL>/models`（帶 key），失敗會明確說原因：連不上
（`could not reach …`）、401/403（需要或換一個 API key）、沒有模型
（先 pull / load 一個，或用 `--model`）。vLLM 的 `max_model_len`、llama.cpp 的
`n_ctx_train`、LM Studio 的 `max_context_length` 會自動帶入 context window。

```bash
unieai login self-hosted list           # 列出伺服器與模型（不印 key）
unieai login self-hosted remove gpu     # 移除
unieai login status                     # 也會列出自架伺服器
```

同一個名稱再 `--self-hosted` 一次就是更新（例如伺服器多了模型）。`unieai logout`
只登出 Studio/Rabi，不動自架伺服器。

### TUI onboarding

第 4 個選項 **Use a self-hosted model server**：輸入 URL → 輸入 API key（可留空，
輸入時只顯示 `•`）→ 探測 `/models` → 顯示找到的模型。401 會回到 key 那一步，
連不上 / 沒模型會回到 URL 那一步並顯示原因。

### 模型名稱

自架模型在 UnieAI Code 裡叫 `<名稱>/<模型 id>`，例如 `local/qwen2.5:0.5b`、
`gpu/Qwen/Qwen3-8B`，所以兩台伺服器（或伺服器和 Studio）有同名模型也不會混。
`config.toml` 的 `model = "local/qwen2.5:0.5b"` 讓它成為預設。

### 引擎

| 引擎 | 支援 |
|---|---|
| **uac**（預設） | 完整支援。每台伺服器在 dsh 的 `settings.yaml` 是一個 `openai-completions` provider，各自一個 key 環境變數（`UNIEAI_SELF_HOSTED_<NAME>_API_KEY`）；key 的值只寫進 dsh 的 `.credentials.yaml`（0600），跟 gateway key 一樣，不會出現在 `settings.yaml`。thread 中途 `/model` 可以在 Studio 模型和各伺服器模型之間切換。 |
| **codex** | 這版 codex 只剩 Responses API（`wire_api = "chat"` 已被上游移除），自架伺服器多半只有 chat completions，所以 **自架模型只在 uac 上跑**：只有自架伺服器、沒有 Studio 登入時自動用 uac；選了自架模型時 `/engine` 不能切到 codex；codex 引擎的 `/model` 不列自架模型。 |

伺服器本身支援 `/v1/responses`（新版 vLLM、Ollama、LM Studio）時，codex 引擎仍可
用 codex 原本的機制直接接：每台自架伺服器也註冊成同名的 model provider，或在
`config.toml` 自己寫：

```toml
model_provider = "gpu"      # 自架伺服器的名稱，或下面自訂的 id
model = "Qwen/Qwen3-8B"     # 這裡用伺服器上的原始 id

[model_providers.my-vllm]
name = "My vLLM"
base_url = "http://gpu-box:8000/v1"
env_key = "VLLM_API_KEY"
wire_api = "responses"
```

`[model_providers.<id>]` 在 uac 上也有效：thread 的 provider 是它時，uac 以
chat completions 連 `base_url`、key 從 `env_key` 讀。

### 沒有 Studio 時的 Studio 專屬功能

| 功能 | 行為 |
|---|---|
| Studio MCP（知識庫、SQL、skills） | 沒有 Studio 登入就不掛；有登入時照常掛（跟模型是哪個無關） |
| gateway web search | 沒有 gateway 就只用自己的 `BRAVE_API_KEY` / `TAVILY_API_KEY` / `SERPAPI_API_KEY`；都沒有時不提供 `web_search` 工具 |
| 看圖 fallback（`describe_image`） | 預設模型不能看圖時，從 Studio 的 vision 模型和標了 `--vision` 的自架模型挑一個（同系列優先，同分時 Studio 優先）；選到自架模型就連那台伺服器、用它的 key；都沒有就不提供 |
| thread 標題（one-shot） | 自架模型的 thread 直接問那台伺服器，不經 gateway |

### 檔案

`~/.unieai/unieai-self-hosted.json`（0600）：

```jsonc
{
  "version": 1,
  "providers": [
    {
      "id": "gpu",
      "base_url": "http://gpu-box:8000/v1",
      "api_key": "…",               // 或 "api_key_env": "VLLM_API_KEY"
      "models": [
        { "id": "Qwen/Qwen3-8B", "context_window": 40960 },
        { "id": "Qwen/Qwen2.5-VL-7B", "vision": true }
      ]
    }
  ]
}
```

可以手動編輯（例如每個模型不同的 context window / vision）。
