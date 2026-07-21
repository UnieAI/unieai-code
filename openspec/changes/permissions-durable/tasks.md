# Tasks: permissions-durable

## 1. 研究對照
- [ ] 1.1 讀 opencode `permission.ts:197-286`、`permission/saved.ts`（每專案規則、自動放行、級聯、CorrectedError）
- [ ] 1.2 讀 `permission/arity.ts`（tree-sitter + arity 表歸併）

## 2. 持久化規則
- [ ] 2.1 專案層規則儲存（action + resource 樣式）
- [ ] 2.2 always → 存規則 + 自動放行已涵蓋待審

## 3. 級聯與修正
- [ ] 3.1 拒絕級聯（同 session 其他待審）
- [ ] 3.2 帶訊息拒絕 → 模型可讀修正回饋

## 4. bash arity 歸併
- [ ] 4.1 tree-sitter + arity 表；同指令不同旗標共用規則

## 5. 驗收
- [ ] 5.1 單元：always 自動放行、拒絕級聯、修正回饋
- [ ] 5.2 單元：git log / git log -n5 歸併同規則
- [ ] 5.3 安全：樣式比對保守，不誤放行
- [ ] 5.4 openspec validate + archive
