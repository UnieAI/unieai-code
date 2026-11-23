# MCP（Model Context Protocol）

UnieAI Code 可以接 MCP server：stdio 的本地指令，或 streamable HTTP 的遠端服務。這份文件是本專案自己的 MCP 說明；上游 Codex 的通用說明在 `docs/` 上層。

## 設定放在哪

| 檔案 | 內容 |
|---|---|
| `~/.unieai/config.toml` | 使用者設定，MCP server 寫在 `[mcp_servers.<名稱>]` |
| `~/.unieai/.credentials.json` | `unieai mcp login` 取得的 OAuth 授權（access token、refresh token、到期時間） |

> 舊版說明文字曾寫 `~/.codex/config.toml`；本 fork 一律使用 `~/.unieai/`。若兩個目錄都存在，以 `~/.unieai/config.toml` 為準。

## 指令

```bash
unieai mcp list                      # 列出已設定的 server 與登入狀態
unieai mcp add space --url https://space.unieai.com/mcp
unieai mcp login space               # 需要本人瀏覽器登入一次
unieai mcp get space                 # 檢查 transport、授權、移除指令
unieai mcp logout space
unieai mcp remove space
```

`add` 的常用旗標：

| 旗標 | 用途 |
|---|---|
| `--url <URL>` | 遠端 streamable HTTP server（省略則為 stdio） |
| `--bearer-token-env-var <VAR>` | 用環境變數裡的靜態 token，不跑 OAuth |
| `--oauth-client-id` / `--oauth-client-secret` | 使用事先註冊好的 OAuth client |
| `--oauth-client-registration <AUTO\|CIMD\|DCR>` | 動態註冊方式，預設 `AUTO` |
| `--oauth-resource <URL>` | 指定 resource indicator |

## OAuth 授權怎麼跑

```bash
unieai mcp add space --url https://space.unieai.com/mcp
```

1. CLI 探測 server 的 protected-resource metadata，發現需要授權。
2. 依 server 的 authorization-server metadata 註冊 client（DCR）或沿用設定的 `client_id`。
3. 產生 PKCE（S256）與 `state`，啟動本機 loopback listener，印出授權網址。
4. 使用者在瀏覽器登入並同意 → 瀏覽器被導回 `http://127.0.0.1:<port>/callback?code=…`。
5. CLI 檢查 `state` 與 `iss`（必須等於 AS metadata 的 issuer），用 verifier 換 token，寫入 `~/.unieai/.credentials.json`，印出 `Successfully logged in.`。

之後 CLI 會自動用 refresh token 續期；`~/.unieai/.credentials.json` 同時是 TUI 內 MCP 工具與外部腳本可共用的授權來源。

**一定要有人在瀏覽器登入一次。** Space 這類服務只提供 `authorization_code` + `refresh_token`，沒有 `client_credentials`、也沒有 device code，所以「加 MCP」本身不會產生 token；差別只在於那一次登入發生在哪台機器。

### 遠端主機：`--remote`

在 SSH／容器裡跑，本機 loopback 收不到瀏覽器回導時，把回導交給 RABI 中繼：

```bash
unieai mcp login space --remote            # 用預設 RABI 位址
unieai mcp login space --remote --remote-url https://<rabi-host>
```

CLI 印出一段中繼網址，任何有瀏覽器的裝置打開即可完成登入。中繼只負責轉交 `code`/`state`，PKCE verifier、token 交換與 `iss` 檢查都留在 CLI；session 10 分鐘後失效。`--remote` 不能與 `--no-browser` 或 `--oauth-client-registration cimd` 併用。

## 常用 server

```toml
# ~/.unieai/config.toml
[mcp_servers.space]
url = "https://space.unieai.com/mcp"
```

Space 提供頁面與資料庫讀寫（`get_page`、`write_page`、`create_doc`、`create_rows`、`submit_case`、`whoami` 等）。AI 助理只能改寫自己寫過的段落；別人的段落要用 `add_comment` 提建議，新內容用 `write_page` 的 `append`。

## 疑難排解

| 症狀 | 處理 |
|---|---|
| `failed to persist config at ~/.unieai/config.toml` | 該檔案權限或所在目錄不可寫；確認 `~` 可寫入後重跑 |
| `authorization required`（401） | 授權被撤銷或過期：`unieai mcp login <名稱>` 重新登入 |
| `invalid_grant` | refresh token 失效（例如重新登入換掉舊授權），重新登入即可 |
| TUI 只看得到舊的 server 清單 | MCP 工具在 session 開始時固定，重開 TUI |
| 授權後瀏覽器停在無法載入的 `127.0.0.1:<port>` | 正常，callback 已由 CLI 接收 |
