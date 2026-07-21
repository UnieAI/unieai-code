# Proposal: theming-notify

**Target:** unieai-code（TUI 外觀與通知）· 來源：opencode `packages/tui/src/theme/`、`feature-plugins/system/notifications.ts`；grok-build `xai-grok-pager-render/src/appearance/`、`theme/color_support.rs`

## Why

外觀與通知是低風險的體驗升級。opencode 有 JSON 主題系統與**從終端 16 色即時生成主題**；grok 有可熱重載的外觀 config、truecolor 量化與 OSC11 背景偵測。加上背景 session 完成的**原生 OS 通知＋音效**，都是 CP 值高的加分。

## What Changes

- **JSON 主題系統**：主題以 JSON 定義（語意角色、ref 到其他 def/role、ANSI 號、dark/light 變體物件、transparent sentinel）；探索分層：內建 < user config < 專案 < cwd，支援 live reload。
- **從終端生成 system 主題**：`generateSystem()` 從終端自身 16 色衍生整套主題（灰階 ramp、柔化文字、染色 diff 底）。
- **色彩層級量化 + OSC11**：偵測終端色彩層級（None/Basic/Ansi256/TrueColor）並把任意 RGB 降級到最佳層級；OSC11 偵測終端背景色以自動選 dark/light。
- **原生 OS 通知 + 音效**：背景（未聚焦）session 完成時發桌面通知＋分事件音效（done/error/permission/question/subagent_done）。

## Capabilities

### New Capabilities
- `theme-system`：JSON 主題定義與探索分層、從終端生成 system 主題、色彩層級量化、OSC11 背景偵測。
- `os-notifications`：背景 session 完成的原生通知與分事件音效。

## Impact

- **落點：unieai-code**（codex-rs/tui）。現行有 theme picker；本 change 升級為 config-driven + 生成主題 + 量化。
- 風險：跨終端/平台的色彩層級與 OSC11 相容性差異，需 fallback（`*_FORCE_COLOR_LEVEL` 環境覆寫）。
