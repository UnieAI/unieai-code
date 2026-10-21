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

# 接自己的模型 API：第三方 API 或自架伺服器（不需要 UnieAI 帳號，見下方）
printenv OPENROUTER_API_KEY | unieai login --api openrouter --with-api-key
unieai login --api http://localhost:8000/v1   # --self-hosted 是同一個參數

unieai logout      # revoke + 刪除 unieai.json
```

流程：要 device code → 顯示連結與代碼、自動開瀏覽器 → 你在 Studio 確認 →
交換 token、抓 gateway 憑證與模型清單 → 寫入 `unieai.json`。

## TUI onboarding

第一次啟動（`~/.unieai` 無憑證）會走互動式登入：
1. **Sign in with UnieAI Rabi**（agent.unieai.com，預設反白）
2. **Sign in with UnieAI Studio**（公有雲）
3. **Sign in with your company's UnieAI Studio**（輸入公司/地端 URL）
4. **Connect a model API (OpenAI, OpenRouter, DeepSeek, Ollama, your server…)**
   （第三方 API 和自架伺服器合在這一個選項，見下方「接自己的模型 API」）

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

## 接自己的模型 API（第三方 API / 自架伺服器）

第三方模型 API（OpenAI、OpenRouter、DeepSeek……）和自己部署的 OpenAI 相容伺服器
（vLLM、SGLang、TGI、llama.cpp server、Ollama、LM Studio……）在 UnieAI Code 裡是
**同一件事**：一個有 base URL、（可選）API key 和模型清單的 provider，**不需要
Studio 或 Rabi 帳號**。只有這些也能開 TUI 聊天；同時有 Studio 登入時，兩邊的模型
都會出現在 `/model`，說明欄標出來源（`OpenAI`、`OpenRouter`、`Self-hosted: gpu`），
Studio 模型標 `UnieAI Studio`。

### 預設的 provider

| `--api` | 名稱（預設 provider id） | Base URL | API key |
|---|---|---|---|
| `openai` | OpenAI（`openai-api`） | `https://api.openai.com/v1` | 必填 |
| `openrouter` | OpenRouter（`openrouter`） | `https://openrouter.ai/api/v1` | 必填 |
| `deepseek` | DeepSeek（`deepseek`） | `https://api.deepseek.com/v1` | 必填 |
| `groq` | Groq（`groq`） | `https://api.groq.com/openai/v1` | 必填 |
| `together` | Together（`together`） | `https://api.together.xyz/v1` | 必填 |
| `mistral` | Mistral（`mistral`） | `https://api.mistral.ai/v1` | 必填 |
| `gemini`（或 `google`） | Google Gemini，OpenAI 相容端點（`gemini`） | `https://generativelanguage.googleapis.com/v1beta/openai` | 必填 |
| `ollama` | Ollama 本機（`ollama-local`） | `http://localhost:11434/v1` | 可留空 |
| `lmstudio`（或 `lm-studio`） | LM Studio 本機（`lmstudio-local`） | `http://localhost:1234/v1` | 可留空 |
| 任何 URL | 自架伺服器（預設取主機名，本機為 `local`） | 你給的 URL | 可留空 |

OpenAI、Ollama、LM Studio 的預設 id 不用 `openai` / `ollama` / `lmstudio`：那些是
內建 provider 的 id（`unieai login --chatgpt`、`--oss`），自己取名也一樣不能用，
`unieai` 也是。

### 新增

```bash
# 第三方 API：key 從 stdin 讀（不會出現在 shell history），存進 UnieAI home（0600）
printenv OPENROUTER_API_KEY | unieai login --api openrouter --with-api-key
printenv OPENAI_API_KEY | unieai login --api openai --with-api-key

# key 不存檔，每次使用時從環境變數讀
unieai login --api deepseek --api-key-env DEEPSEEK_API_KEY

# 模型很多（OpenRouter 幾百個）時只留指定的幾個
printenv OPENROUTER_API_KEY | unieai login --api openrouter --with-api-key \
  --model anthropic/claude-sonnet-4.5 --model qwen/qwen3-coder

# 本機 Ollama（預設）或任何 URL 的自架伺服器（沒寫 scheme 預設 http://，沒寫路徑補 /v1）
unieai login --api ollama
unieai login --api localhost:11434
printenv VLLM_API_KEY | unieai login --api http://gpu-box:8000/v1 --name gpu --with-api-key

# 伺服器不列 /models，或只想用其中幾個：手動指定模型、context window、vision
unieai login --api http://box:8080/v1 --model my-model --context-window 65536 --vision
```

`--self-hosted` 是 `--api` 的別名，舊指令照樣能用。

| 參數 | 作用 |
|---|---|
| `--api <PRESET\|URL>` | 上表的 preset 名稱，或 OpenAI 相容 base URL（通常以 `/v1` 結尾）。別名 `--self-hosted` |
| `--name <名稱>` | provider id（小寫英數、`-`、`_`，不能是內建 id）；預設見上表 |
| `--with-api-key` | 從 stdin 讀 API key，存進 `unieai-self-hosted.json`（0600） |
| `--api-key-env <VAR>` | 只記環境變數名稱，使用時才讀 |
| `--model <ID>` | 手動指定模型（可重複），取代 `GET /models` 的結果 |
| `--context-window <N>` | 模型的 context window；未知時保守預設 32768 |
| `--vision` | 模型可以看圖 |

新增時會先打 `GET <URL>/models`（帶 key），失敗會明確說原因：連不上
（`could not reach …`）、401/403（Gemini 是 400 "API key"：需要或換一個 API key）、
沒有模型（先 pull / load 一個，或用 `--model`）。雲端 preset 沒給 key 直接報錯，
不會去打。

模型清單：
- 只留聊天模型：embedding、whisper、tts、dall-e、moderation、transcribe、rerank、
  gpt-image 這類 id 會跳過。
- 一個 provider **最多存 50 個**（OpenRouter 會列幾百個，全存會淹沒 `/model`），
  照伺服器列的順序取前 50 個，CLI 會說「the first 50 of 468 listed」；要別的就用
  `--model` 指定，TUI 可以先打字篩選。
- context window 取 `/models` 回的值：OpenRouter 的 `context_length`、vLLM 的
  `max_model_len`、llama.cpp 的 `n_ctx_train`、LM Studio 的 `max_context_length`；
  沒有就用預設 32768。OpenRouter 的 `architecture.input_modalities` 有 `image` 時
  自動標成可看圖。

```bash
unieai login api list                   # 列出 provider 與模型（不印 key）
unieai login api remove openrouter      # 移除
unieai login status                     # 也會列出這些 provider
```

`unieai login self-hosted list|remove` 是同一組指令的別名。同一個名稱再 `--api`
一次就是更新（例如伺服器多了模型）。`unieai logout` 只登出 Studio/Rabi，不動這些
provider。

### TUI onboarding

第 4 個選項 **Connect a model API (OpenAI, OpenRouter, DeepSeek, Ollama, your
server…)**：
1. 選 provider：上表 9 個 preset，最後一個是 **Custom URL (vLLM, SGLang,
   llama.cpp, your own server…)**（再輸入 URL）。
2. 輸入 API key：雲端 preset 必填，本機和 Custom URL 可留空；輸入時只顯示 `•`。
3. 探測 `/models`，顯示找到幾個模型和前幾個（含 context window、vision）；可以打字
   篩選（例如 `claude`、`qwen coder`），Enter 存下符合的模型（最多 50 個）。

401 會回到 key 那一步；preset 連不上也回到 key 那一步（URL 是固定的），Custom URL
連不上 / 沒模型會回到 URL 那一步，都會顯示原因。

### 模型名稱

這些模型在 UnieAI Code 裡叫 `<名稱>/<模型 id>`，例如 `ollama-local/qwen2.5:0.5b`、
`gpu/Qwen/Qwen3-8B`、`openrouter/anthropic/claude-sonnet-4.5`（第一個 `/` 前是
provider），所以兩個 provider（或 provider 和 Studio）有同名模型也不會混。
`config.toml` 的 `model = "openrouter/anthropic/claude-sonnet-4.5"` 讓它成為預設。

### 引擎

| 引擎 | 支援 |
|---|---|
| **uac**（預設） | 全部 provider 完整支援。每個 provider 在 dsh 的 `settings.yaml` 是一個 `openai-completions` provider（`displayName` 是 `OpenRouter`、`gpu (self-hosted)` 這類標籤），各自一個 key 環境變數（`UNIEAI_SELF_HOSTED_<NAME>_API_KEY`）；key 的值只寫進 dsh 的 `.credentials.yaml`（0600），跟 gateway key 一樣，不會出現在 `settings.yaml`。thread 中途 `/model` 可以在 Studio 模型和各 provider 的模型之間切換。 |
| **codex** | 這版 codex 只剩 Responses API（`wire_api = "chat"` 已被上游移除）。**OpenAI** 本身有 Responses API，所以 OpenAI preset 也能在 codex 上跑（見下）；其他 preset 和自架伺服器多半只有 chat completions，**只在 uac 上跑**：只有這些、沒有 Studio 登入時自動用 uac；選了它們的模型時 `/engine` 不能切到 codex；codex 引擎的 `/model` 不列它們。 |

codex 引擎用 OpenAI preset，或伺服器本身支援 `/v1/responses`（新版 vLLM、Ollama、
LM Studio）時，用 codex 原本的機制直接接：每個 provider 也註冊成同名的 model
provider，或在 `config.toml` 自己寫：

```toml
model_provider = "openai-api"   # provider 的名稱，或下面自訂的 id
model = "gpt-5"                 # 這裡用 provider 上的原始 id

[model_providers.my-vllm]
name = "My vLLM"
base_url = "http://gpu-box:8000/v1"
env_key = "VLLM_API_KEY"
wire_api = "responses"
```

`model_provider` 是 OpenAI preset 的 provider 時，`/engine` 允許 codex；沒設時，
選了 OpenAI 模型而切 codex 的提示會直接給上面這兩行。

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
      "id": "openrouter",
      "kind": "openrouter",           // preset；"custom" 或沒有 = 自架伺服器
      "base_url": "https://openrouter.ai/api/v1",
      "api_key": "…",
      "models": [
        { "id": "anthropic/claude-sonnet-4.5", "context_window": 1000000, "vision": true }
      ]
    },
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
