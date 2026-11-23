# 思考強度（reasoning effort）

UnieAI Code 把「模型要想多久」當成一個獨立旋鈕，不必換模型。旋鈕最後變成 gateway 請求裡的
`reasoning_effort` 參數；模型若在 gateway 端不支援這個參數，這個旋鈕就不會出現。

## 七個等級

| 等級（UI / 設定檔） | 送給 gateway 的值 | 什麼時候用 |
|---|---|---|
| `none` | `"none"` | 逐字稿整理、格式轉換、明確的機械性修改 |
| `minimal` | `"minimal"` | 單檔小改、查一行資料 |
| `low` | `"low"` | 一般問答、讀懂一段程式碼 |
| `medium`（預設） | `"medium"` | 多數實作任務的平衡點 |
| `high` | `"high"` | 跨檔案重構、需要先想清楚再動手 |
| `xhigh` | `"xhigh"` | 疑難 bug、競態、協議或加密相關 |
| `max` | `"max"` | 只在真的卡住時用；很慢、很貴 |

DeepSeek V4 系列另外接受 `1`–`100` 的整數 token 預算，`minimal` / `medium` 是
`low` / `high` 的別名。gateway 對不認得的等級直接回 HTTP 400 並列出可用的值，
所以打錯字會立刻看到錯誤，不會默默被忽略。

## 怎麼調整

```bash
unieai -c model_reasoning_effort="high"   # 只改這次啟動，不動設定檔
```

TUI 內三個入口：

| 入口 | 作用 |
|---|---|
| `/model` | 選模型；該模型有多個思考等級時再進一層選等級（選完就套用到這個 session） |
| `Alt+.` 或 `Shift+↑` | 提高一級 |
| `Alt+,` 或 `Shift+↓` | 降低一級 |

快捷鍵可在 `~/.unieai/config.toml` 的 `[tui.keymap.chat]` 改綁：

```toml
[tui.keymap.chat]
increase_reasoning_effort = ["alt-."]
decrease_reasoning_effort = ["alt-,"]
```

預設綁定見 `codex-rs/tui/src/keymap.rs`。要固定下來就寫進 `~/.unieai/config.toml`：

```toml
model = "DeepSeek-V4.1-Flash-1017"
model_reasoning_effort = "medium"
```

沒寫 `model_reasoning_effort` 時，第一個 turn 會用模型的預設等級（DeepSeek V4 是
`medium`）。

## 兩個引擎怎麼傳

| 引擎 | 路徑 |
|---|---|
| `codex`（Rust 迴圈） | 直接放進 Responses／Chat Completions 請求 |
| `uac`（Rabi Harness） | ACP `session/set_config_option` 的 `reasoning_effort`；rabi 再寫成 gateway 的 `reasoning_effort` |

兩邊的等級名稱一致，只有「關掉思考」這一級不同名：codex 叫 `none`，rabi 叫 `off`，
送給 gateway 都是 `"none"`（rabi 的 `off: null` 代表「這個參數不要送」，等於用供應商
預設值，模型仍然會想——所以不能拿它當關閉）。

## 為什麼有時候看不到這個旋鈕

rabi 只有在模型資訊帶著「這個模型有哪些思考等級」時，才會把 `reasoning_effort` 這個
ACP 選項提供給 client。這份等級表有兩個來源：

1. gateway 的模型清單（`/v1/models`）若有宣告 `reasoning_levels` / `reasoning_efforts`，以它為準。
2. 沒有宣告時，本專案按模型家族補上（目前是 `deepseek-v4*`），見
   `codex-rs/models-manager/src/model_info.rs` 的 `gateway_reasoning_ladder()` 與
   `agent-runtime/src/unieai-rabi/config.mjs` 的 `gatewayReasoningEfforts()`——兩份必須同步。

不在表上的模型（例如 `Qwen3.6-35B-A3B`）不會拿到旋鈕，避免送一個被忽略的參數。
若選到的等級模型不支援，engine 會寫一行 log 並保留原本的等級，不會讓 turn 失敗：

```
<model> offers no reasoning effort "<level>"; keeping <current>
```

## 疑難排解

| 症狀 | 原因 / 處理 |
|---|---|
| `/model` 裡沒有思考強度 | 該模型沒有等級表；見上一節，或在 gateway 端宣告 `reasoning_levels` |
| 改了 `config.toml` 沒反應 | 設定檔路徑是 `~/.unieai/config.toml`（舊文件的 `~/.codex/` 不生效） |
| HTTP 400 提到 reasoning effort | 等級字串不合法；gateway 的錯誤訊息會列出可用值 |
| `none` 還是看得到思考內容 | 那是 rabi 的 `off`（不送參數＝供應商預設，仍會想）。本專案的 `none` 會明確送出 `"none"` |

## 看得到思考本身嗎

上面調的是「想多久」，另一件事是「看不看得到它在想」。uac 引擎把 rabi 送來的思考文字
放進 transcript 的 reasoning 項目（`summary` 欄位），TUI 畫成收合的「Thinking」區塊；
那份文字就是模型實際的思考內容，rabi 沒有另外產生摘要。不想看到就關掉思考（`none`）。

codex 引擎的原始 CoT 另外受 `~/.unieai/config.toml` 的 `show_raw_agent_reasoning`
控制（預設 `false`），那是 codex 自己的 reasoning 通道；uac 沒有第二份文字，
所以這個設定對 uac 沒有作用。
