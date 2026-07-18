# UnieAI Code 文件

UnieAI Code 是以 [openai/codex](https://github.com/openai/codex)（Rust）為基底、接上 UnieAI 平台的編碼 agent。這個資料夾放 fork 專屬的文件；繼承自 codex 的通用文件在 `docs/` 上層。

## 目錄

| 文件 | 內容 |
|---|---|
| [architecture.md](architecture.md) | 整體架構：CLI/TUI、雙引擎、agent-core 收斂、開源模型 harness |
| [login.md](login.md) | UnieAI Studio 登入（device flow、公司/地端、gateway 憑證） |
| [vscode-extension.md](vscode-extension.md) | VS Code 聊天面板：安裝、雙引擎、功能 |
| [benchmarks.md](benchmarks.md) | Benchmark 方法與結果（HumanEval、SWE-bench） |

## 三個 repo 的關係

```
UnieAI/unieai-code            ← 這個 repo（codex 基底的 CLI/TUI/VS Code 插件）
  └─ third_party/
       unieai-agent-core      ← submodule（純流程迴圈，與 UnieAI Studio 共用）
UnieAI/Unieai-Code-Publish    ← 發佈通路（cli-v* releases、install.sh）
```

## 快速上手

```bash
git clone --recursive -b unieai-codex https://github.com/UnieAI/unieai-code.git
cd unieai-code/codex-rs && cargo build --release --bin codex
./target/release/codex login --studio-url https://studio.unieai.com
./target/release/codex           # 進 TUI
```
