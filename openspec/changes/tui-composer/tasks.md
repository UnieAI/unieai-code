# Tasks: tui-composer

## 1. 研究對照
- [~] 1.1 讀 grok `actions/mod.rs`、`views/modal.rs`（ActionRegistry、palette、arg-picker）
      → 外部 repo 不在磁碟，依規格描述 + 既有知識重建；ActionRegistry/模糊排序落地於 `action_registry.rs`。
- [~] 1.2 讀 `views/prompt_suggestion.rs`（ghost 推導）、`prompt_widget/mod.rs`（chip 元素）、`tips/`（TTL 提示）
      → 同上，ghost/chip/TTL 純模型分別落地於 `composer_ghost.rs`、`composer_chip.rs`、`composer_tip.rs`。
- [~] 1.3 讀 opencode `feature-plugins/system/which-key.tsx`（which-key 疊層）
      → 同上，mode-stack + 可達鍵位推導落地於 `which_key.rs`。

## 2. 命令面板
- [x] 2.1 把既有 action 收斂到單一 registry — **live-wired（slash commands）**
      → registry 型別 + 模糊排序核心（`action_registry.rs`）已由 Ctrl+P 面板實際使用：
        `bottom_pane/command_palette_view.rs` 以 `/` popup 的同一組 command 集合
        （`CommandPopup::palette_items`，同 availability flags／alias／debug 過濾）建 `Registry`
        （id=command name、title=description），`Registry::filter` 供模糊排名。
        **仍延後**：非 slash 的既有 codex action（鍵位 dispatch、shortcut bar）收斂進 registry；
        `KeyChord`/`lookup_binding`/`by_id` 等保留逐項 `#[allow(dead_code)]`。
- [x] 2.2 模糊面板 + arg-picker 鏈 — **live-wired（Ctrl+P palette）**
      → Ctrl+P（`chatwidget/interaction.rs`，僅在無 modal view／composer popup 時攔截）開啟
        `CommandPaletteView`（bottom-pane view：輸入列 + 排名列表 + 選取高亮 + 捲動，
        Up/Down/Ctrl+N 導覽、Enter 送出、Esc 關閉）。Dispatch 重用 `/` popup 的同一路徑：
        `AppEvent::CommandPaletteSelection` → `ChatWidget::handle_command_palette_selection` →
        `handle_slash_command_dispatch`／`handle_service_tier_command_dispatch`
        （即 popup `InputResult::Command`／`ServiceTierCommand` 的同一 handler）；
        arg-picker = 帶參數命令（`supports_inline_args`）不直接執行，插入 `/name ` 進 composer
        （同 command_popup 補全行為，並重開 `/` popup 供輸入參數）。
        10 unit tests + 1 insta render snapshot（`command_palette_mo`）。
        **鍵位註記**：Ctrl+P 原為 composer editor `move_up` 的 Emacs 別名（Up 鍵仍在）；
        Ctrl+K 因綁 kill-to-end-of-line（唯一綁定、有測試）不採用，故面板取 Ctrl+P，
        僅遮蔽 plain composer 情境（popup／list 內的 Ctrl+P 導覽不受影響）。
        **仍延後**：快捷提示（binding 顯示）、which-key／ghost／chip 的 live wiring。

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
- [x] 3.4 which-key 疊層 + mode-stack — **live-wired（'?' overlay）**
      → 純模型 `which_key.rs`：`Mode`/`ModeStack{push,pop,current,depth}`、`rows()`（bottom→top union，內層 mode
        覆寫外層同鍵，確定性排序）、`pages(per_page)` 分頁。6 tests。
        **Live wiring**：空 composer 按 `?`（lazygit/k9s 慣例；無 modal/popup、非 paste-burst 時，
        `chatwidget/interaction.rs` 攔截）→ `BottomPane::open_which_key()` 推入
        `bottom_pane/which_key_view.rs`（BottomPaneView）。綁定表 `composer_which_key_groups`
        由真實來源建構：resolved `RuntimeKeymap`（composer/editor/chat/app 各 context 的
        primary binding，user rebind 自動反映、unbind 自動消行）+ interaction.rs 硬編碼攔截
        （Ctrl+P palette、Ctrl+C/Ctrl+D quit、Ctrl+V 貼圖、BackTab collaboration mode）+
        composer popup 觸發字元（`/`、`@`），共 24 列、4 組（Conversation/Editing/Navigation/Other）。
        關閉語意：Esc 關閉；可列印字元關閉**且**經 `AppEvent::InsertComposerText` 重新打進
        composer（`?` 按兩下＝輸入字面 `?` 的逃生口）；多頁時 Left/Right/PgUp/PgDn 翻頁（clamp）；
        其他鍵只關閉（app event loop 無 raw key 重派發機制，非列印鍵被吞掉）。
        composer 非空時 `?` 完全不攔截、照常輸入（regression test 佐證）。
        **mode-stack 使用註記（誠實）**：plain composer 是單一 context（尚無 sub-mode），
        `ModeStack` 疊層/覆寫在 live wiring 中未被行使——view 直接用 `WhichKeyRow` +
        group-aware 分頁（header 跟列不分離、超大 group 以 "(cont.)" 續頁）取代 `pages()`；
        純模型與其 6 tests 保留，供未來 sub-mode（如 git/search context）接上。
        **取捨註記**：`?` 原本（空 composer 時）toggle footer 的精簡 ShortcutOverlay
        （`composer.toggle_shortcuts` 預設 `?`/`shift-?`）；本 overlay 於預設鍵位下取代它，
        使用者若把 `toggle_shortcuts` rebind 到其他鍵，該 footer overlay 仍可用（僅字面 `?` 被攔）。
        8 unit tests + 1 insta snapshot（`which_key_overlay`）+ 2 chatwidget regression tests
        （`chatwidget/tests/popups_and_settings.rs`）。

## 4. 驗收
- [x] 4.1 單元：ghost 推導（相符縮短/發散隱藏）— `composer_ghost.rs` 9 tests（含空輸入全句、相符縮短、
      發散隱藏、全打完隱藏、accept 合併、大小寫、非 ASCII 邊界）。
- [x] 4.2 單元：chip range 位移、展開送出 — `composer_chip.rs` 11 tests（前後/內部位移、插入/刪除/取代、
      `shift_all` 保留+丟棄、多 chip 任意順序 expand）。
- [x] 4.3 snapshot：面板、which-key — 面板（insta `command_palette_mo`，filter 套用後 render）；
      which-key（insta `which_key_overlay`，page 1/3 於 64 欄 render，含群組標題與 chord 對齊）。
- [~] 4.4 openspec validate + archive — `openspec validate tui-composer --strict` pass；archive 待 orchestrator。

## Staging note
本輪比照 `color_support.rs` / `scrollback_verb_group.rs` 既有做法，只交付**自足、單元測試、additive** 的純核心
模組（登記於 `lib.rs` 的 `mod …;`，各檔內含 `#![allow(dead_code)]`），**不改動 live 輸入/render 路徑**。
完整 live 整合（重綁鍵位、替換真實 TextArea、收斂既有 action、面板/which-key/ghost/chip render、小模型預測呼叫）
為高風險，明確延後為後續 wiring。新增檔：`action_registry.rs`、`composer_ghost.rs`、`composer_chip.rs`、
`composer_tip.rs`、`which_key.rs`（共 41 unit tests）。
