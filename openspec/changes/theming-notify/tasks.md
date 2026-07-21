# Tasks: theming-notify

## 1. 研究對照
- [ ] 1.1 讀 opencode `theme/index.ts`（JSON、ref、dark/light、generateSystem）、`context/theme.tsx`（探索分層、reload）
- [x] 1.2 讀 grok `theme/color_support.rs`（量化）、`osc11.rs`（已對照移植到 codex-rs tui `color_support.rs`）
- [ ] 1.3 讀 opencode `feature-plugins/system/notifications.ts` + `attention.ts` + `audio.ts`

## 2. JSON 主題系統  — DEFERRED（大型改寫，超出本次範圍，另案處理）
- [ ] 2.1 JSON schema（語意角色、ref、ANSI 號、dark/light、transparent）
- [ ] 2.2 探索分層（內建<user<專案<cwd）+ live reload
- [ ] 2.3 generateSystem()（從終端 16 色衍生）

## 3. 量化與背景偵測
- [x] 3.1 色彩層級偵測 + RGB 量化 + 環境覆寫
      → 新增 `codex-rs/tui/src/color_support.rs`：`ColorLevel{None,Basic,Ansi256,TrueColor}`、
        `level_from_env`（NO_COLOR / `UNIEAI_FORCE_COLOR_LEVEL`|`CODEX_FORCE_COLOR_LEVEL` 覆寫 / COLORTERM / TERM）、
        `quantize`（truecolor→ansi256 6×6×6 cube+24 級灰階→basic 16 named），全部單元測試。
- [~] 3.2 OSC11 背景偵測 → 自動 dark/light
      → 純解析/分類 helper 已實作並測試（`parse_osc11_rgb`、`classify_luminance`、`Appearance`）。
        實時 TTY 往返查詢未接（codex 既有以 crossterm `query_background_color` 走另一路徑），故延後。

## 4. OS 通知  — 既有 codex 已完整實作，驗證後沿用（未重複造輪）
- [x] 4.1 背景 session 完成 → 桌面通知；前景不打擾
      → 既有：`tui/src/notifications/{mod,osc9,bel}.rs`（OSC 9 + tmux DCS passthrough，BEL fallback，
        依終端自動選擇）；焦點追蹤 `terminal_focused: AtomicBool`（crossterm FocusGained/Lost）；
        `NotificationCondition::Unfocused`（預設）於聚焦時抑制；回合完成於
        `chatwidget/turn_runtime.rs:215 notify(AgentTurnComplete)` 觸發。符合規格，無需新增。
- [ ] 4.2 分事件音效（done/error/permission/question/subagent_done）
      → DEFERRED：規格為 MAY；需音訊 crate（非終端原生 escape），與「薄 diff」原則相悖，延後。

## 5. 驗收
- [~] 5.1 單元：量化到各層級、dark/light 選擇 → 已完成（22 tests pass）；ref 解析屬 JSON 主題（延後）
- [ ] 5.2 手測：跨終端（truecolor/256）、OS 通知
- [ ] 5.3 openspec validate + archive
