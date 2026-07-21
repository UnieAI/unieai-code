# Tasks: tui-composer

## 1. 研究對照
- [ ] 1.1 讀 grok `actions/mod.rs`、`views/modal.rs`（ActionRegistry、palette、arg-picker）
- [ ] 1.2 讀 `views/prompt_suggestion.rs`（ghost 推導）、`prompt_widget/mod.rs`（chip 元素）、`tips/`（TTL 提示）
- [ ] 1.3 讀 opencode `feature-plugins/system/which-key.tsx`（which-key 疊層）

## 2. 命令面板
- [ ] 2.1 把既有 action 收斂到單一 registry
- [ ] 2.2 模糊面板 + 快捷提示 + arg-picker 鏈

## 3. composer 輔助
- [ ] 3.1 ghost 下一句（每幀從文字推導；Tab/Right 接受）— 預測用小模型
- [ ] 3.2 貼上/圖片 chip（帶 range、可展開、跨 stash/restore）
- [ ] 3.3 TTL 教學提示（打字不消、seen-count 上限）
- [ ] 3.4 which-key 疊層 + mode-stack

## 4. 驗收
- [ ] 4.1 單元：ghost 推導（相符縮短/發散隱藏）
- [ ] 4.2 單元：chip range 位移、展開送出
- [ ] 4.3 snapshot：面板、which-key
- [ ] 4.4 openspec validate + archive
