# Tasks: tui-composer

## 1. 研究對照
- [~] 1.1 讀 grok `actions/mod.rs`、`views/modal.rs`（ActionRegistry、palette、arg-picker）
      → 外部 repo 不在磁碟，依規格描述 + 既有知識重建；ActionRegistry/模糊排序落地於 `action_registry.rs`。
- [~] 1.2 讀 `views/prompt_suggestion.rs`（ghost 推導）、`prompt_widget/mod.rs`（chip 元素）、`tips/`（TTL 提示）
      → 同上，ghost/chip/TTL 純模型分別落地於 `composer_ghost.rs`、`composer_chip.rs`、`composer_tip.rs`。
- [~] 1.3 讀 opencode `feature-plugins/system/which-key.tsx`（which-key 疊層）
      → 同上，mode-stack + 可達鍵位推導落地於 `which_key.rs`。

## 2. 命令面板
- [~] 2.1 把既有 action 收斂到單一 registry
      → 僅落地 registry 型別 + 模糊排序核心（`action_registry.rs`：`Action{id,title,keywords,binding,needs_arg}`、
        `Registry::{filter,lookup_binding,by_id}`、`fuzzy_score` 子序列排序、`KeyChord`（crossterm 鍵模型 + Display）），
        10 tests。**未做**：真正把既有 codex action 收斂進 registry（高風險 live-path 重構，明確延後）。
- [~] 2.2 模糊面板 + 快捷提示 + arg-picker 鏈
      → 純資料層已備妥（`filter` 供模糊面板、`needs_arg` 供 arg-picker 判斷、`binding` 供快捷提示）；
        面板 widget／arg-picker 鏈的實際 render 與輸入路徑串接延後（需 live TextArea/overlay 整合）。

## 3. composer 輔助
- [x] 3.1 ghost 下一句（每幀從文字推導；Tab/Right 接受）— 預測用小模型
      → `composer_ghost.rs`：`ghost_suffix`（每幀從當前文字推導，無狀態機；空輸入→全句、相符前綴→縮短、
        發散→隱藏、ASCII 大小寫不敏感且守 char boundary）、`ghost_visible`、`accept_ghost`（input+ghost）。9 tests。
        **未做**：小模型「預測下一句」引擎呼叫 + 灰字 render + Tab/Right 綁定（live 整合，延後）。
- [x] 3.2 貼上/圖片 chip（帶 range、可展開、跨 stash/restore）
      → `composer_chip.rs`：`Chip{kind:Paste{lines}|Image{n}, range, content}`、`placeholder()`
        （`[Pasted N lines]`/`[Image #N]`，含單複數）、`shift_chip`/`shift_all`（前位移／後不動／內部觸碰即
        `Invalidated`，插入/刪除/取代皆測）、`expand`（送出時還原全文，任意順序、越界防呆）。11 tests。
        **未做**：自訂 TextArea 元素模型 + 實際 stash/restore 存活（live 整合，延後）。
- [x] 3.3 TTL 教學提示（打字不消、seen-count 上限）
      → `composer_tip.rs`：`Tip{id,seen_count,max_seen,ttl}`、`should_show`/`show`/`tick`（注入式時鐘）/
        `on_submit`/`is_visible`。打字不呼叫任何 hide（只有 tick=時間 與 submit 清除）、每 session seen 上限後不再出現。5 tests。
- [x] 3.4 which-key 疊層 + mode-stack
      → `which_key.rs`：`Mode`/`ModeStack{push,pop,current,depth}`、`rows()`（bottom→top union，內層 mode
        覆寫外層同鍵，確定性排序）、`pages(per_page)` 分頁。6 tests。**未做**：疊層 render（純資料，延後）。

## 4. 驗收
- [x] 4.1 單元：ghost 推導（相符縮短/發散隱藏）— `composer_ghost.rs` 9 tests（含空輸入全句、相符縮短、
      發散隱藏、全打完隱藏、accept 合併、大小寫、非 ASCII 邊界）。
- [x] 4.2 單元：chip range 位移、展開送出 — `composer_chip.rs` 11 tests（前後/內部位移、插入/刪除/取代、
      `shift_all` 保留+丟棄、多 chip 任意順序 expand）。
- [ ] 4.3 snapshot：面板、which-key — **DEFERRED**：需 live widget/render（本輪為純核心邏輯，無 render）。
- [~] 4.4 openspec validate + archive — `openspec validate tui-composer --strict` pass；archive 待 orchestrator。

## Staging note
本輪比照 `color_support.rs` / `scrollback_verb_group.rs` 既有做法，只交付**自足、單元測試、additive** 的純核心
模組（登記於 `lib.rs` 的 `mod …;`，各檔內含 `#![allow(dead_code)]`），**不改動 live 輸入/render 路徑**。
完整 live 整合（重綁鍵位、替換真實 TextArea、收斂既有 action、面板/which-key/ghost/chip render、小模型預測呼叫）
為高風險，明確延後為後續 wiring。新增檔：`action_registry.rs`、`composer_ghost.rs`、`composer_chip.rs`、
`composer_tip.rs`、`which_key.rs`（共 41 unit tests）。
