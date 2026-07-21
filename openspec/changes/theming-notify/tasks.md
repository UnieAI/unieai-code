# Tasks: theming-notify

## 1. 研究對照
- [ ] 1.1 讀 opencode `theme/index.ts`（JSON、ref、dark/light、generateSystem）、`context/theme.tsx`（探索分層、reload）
- [ ] 1.2 讀 grok `appearance/config.rs`、`appearance/watcher.rs`、`theme/color_support.rs`（量化）、`osc11.rs`
- [ ] 1.3 讀 opencode `feature-plugins/system/notifications.ts` + `attention.ts` + `audio.ts`

## 2. JSON 主題系統
- [ ] 2.1 JSON schema（語意角色、ref、ANSI 號、dark/light、transparent）
- [ ] 2.2 探索分層（內建<user<專案<cwd）+ live reload
- [ ] 2.3 generateSystem()（從終端 16 色衍生）

## 3. 量化與背景偵測
- [ ] 3.1 色彩層級偵測 + RGB 量化 + 環境覆寫
- [ ] 3.2 OSC11 背景偵測 → 自動 dark/light

## 4. OS 通知
- [ ] 4.1 背景 session 完成 → 桌面通知；前景不打擾
- [ ] 4.2 分事件音效（done/error/permission/question/subagent_done）

## 5. 驗收
- [ ] 5.1 單元：量化到各層級、ref 解析、dark/light 選擇
- [ ] 5.2 手測：跨終端（truecolor/256）、OS 通知
- [ ] 5.3 openspec validate + archive
