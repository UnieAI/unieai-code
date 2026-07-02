# UnieAI Code

<p align="center">
  <img src="docs/images/app-icon.png" alt="UnieAI Code" width="240">
</p>

<div align="center">

[![GitHub Stars](https://img.shields.io/github/stars/UnieAI/unieai-code?style=social)](https://github.com/UnieAI/unieai-code/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/UnieAI/unieai-code)](https://github.com/UnieAI/unieai-code/issues)
[![npm](https://img.shields.io/npm/v/@unieai/code)](https://www.npmjs.com/package/@unieai/code)
[![中文](https://img.shields.io/badge/🇨🇳_中文-当前-blue)](README.md)
[![English](https://img.shields.io/badge/🇺🇸_English-Available-green)](README.en.md)

</div>

UnieAI Code 是一个集成 **UnieAI Studio** 的 AI 命令行编程工具（CLI）：在终端里完成会话、多项目、分支 / Worktree、代码改动与 Diff、权限审批、模型提供商管理、Computer Use 等日常开发工作流。

<p align="center">
  <a href="#近期更新">近期更新</a> · <a href="#安装命令行cli">安装 CLI</a> · <a href="#从源码启动-cli">从源码启动</a> · <a href="#更多文档">更多文档</a>
</p>

---

## 近期更新

- **npm 包瘦身 ~98%**：以前发布时会把整个源码树（含 `docs/`、`packages/`、测试等）一起打包，约 **116 MB / 3200 文件**。现在改为只发布经 `bun build` 打包并压缩后的 `dist/`，约 **2.2 MB / ~340 文件**（运行时仍由 bun 执行）。`dist/` 在 `prepublishOnly` 阶段自动构建、已加入 `.gitignore`，不会提交；本地开发仍直接跑 `src/`，改动即时生效。
- **企业 / 地端 UnieAI Studio 整合**：支持云端与企业自建 Studio 登录；推理网关（gateway）可自动从 Studio 网址推导、在登录时手动填写，或用 `UNIEAI_GATEWAY_URL` 覆盖，修复了地端登录成功但 API 打不通的问题。详见 [安装命令行（CLI）](#安装命令行cli)。

---

## 安装命令行（CLI）

`@unieai/code` 以 [Bun](https://bun.sh) 为运行时，请先确认本机已安装 bun 并在 PATH 上。

```bash
# 安装 / 升级到最新版
npm install -g @unieai/code

# 验证
unieai --version
```

安装后用 `unieai` 启动交互式会话。如需重新安装或固定版本：

```bash
npm uninstall -g @unieai/code
npm install -g @unieai/code@latest
```

> npm 包只发布打包后的 `dist/`（体积约 2 MB；运行时仍由 bun 执行 JS），不再附带整个源码树。

### 免 npm 安装（独立二进制）

不想装 npm / bun 也可以。每个版本的 [GitHub Release](https://github.com/UnieAI/unieai-code/releases) 会附带用 `bun build --compile` 打包的**单文件可执行档**（已内嵌 Bun 运行时与全部依赖，下载即用）：

```bash
# macOS / Linux：自动识别系统架构、下载最新版到 ~/.local/bin/unieai
curl -fsSL https://raw.githubusercontent.com/UnieAI/unieai-code/main/install.sh | sh

unieai --version
```

- 固定版本：`UNIEAI_VERSION=cli-v0.0.14 curl -fsSL .../install.sh | sh`
- 自定安装位置：`UNIEAI_INSTALL_DIR=/usr/local/bin`
- **Windows**：从 Releases 页面下载 `unieai-windows-x64.exe` 直接运行。
- 也可手动到 Releases 下载对应档案（`unieai-macos-arm64` / `unieai-macos-x64` / `unieai-linux-x64` / `unieai-linux-arm64`），`chmod +x` 后放进 PATH 即可。macOS 若从浏览器手动下载，首次运行被 Gatekeeper 拦截时执行 `xattr -d com.apple.quarantine <文件>`（用上面的 `curl | sh` 安装则不会有此问题）。

> 独立二进制不含 `sharp`（图片缩放）、OTLP exporter、第三方供应商 SDK（Bedrock/Vertex 等）等可选依赖；需要时请改用 npm 安装。

### 登录 UnieAI Studio

首次启动会要求登录，可选：

- **UnieAI Studio**：使用云端账号（`https://studio.unieai.com`）。
- **Company UnieAI Studio**：填入企业 / 地端 Studio 网址（例如 `https://studio.demo.unieai.com`）。

企业 / 地端部署的推理网关（gateway）常与登录网址不同。登录流程会有一个**选填**的 “Inference gateway URL” 步骤：

- 留空 → 自动从 Studio 网址推导（`studio.` → `api.`）。
- 或手动填写网关地址（通常以 `/v1` 结尾）。

也可以用环境变量覆盖（对已登录的会话同样生效，无需重新登录）：

```bash
export UNIEAI_GATEWAY_URL="https://api.your-company.com/v1"
```

## 从源码启动 CLI

适合想调试底层 CLI、服务端或自行开发的用户：

```bash
bun install
cp .env.example .env
./bin/cli.mjs
```

> 开发时直接从 `src/` 运行，改动即时生效。npm 发布时会通过 `prepublishOnly` 自动执行 `bun run build` 生成 `dist/`（已在 `.gitignore` 中，不会提交）。

更多配置见 [环境变量](docs/guide/env-vars.md) 和 [全局使用](docs/guide/global-usage.md)。

---

## 更多文档

| 文档 | 说明 |
|------|------|
| [环境变量](docs/guide/env-vars.md) | 完整环境变量参考和配置方式 |
| [第三方模型](docs/guide/third-party-models.md) | 接入 OpenAI / DeepSeek / Ollama 等非 Anthropic 模型 |
| [贡献与质量门禁](docs/guide/contributing.md) | 本地测试、真实模型 baseline、PR 和 release 门禁 |
| [记忆系统](docs/memory/01-usage-guide.md) | 跨会话持久化记忆的使用与实现 |
| [多 Agent 系统](docs/agent/01-usage-guide.md) | 多代理编排、并行任务执行与 Teams 协作 |
| [Skills 系统](docs/skills/01-usage-guide.md) | 可扩展能力插件、自定义工作流与条件激活 |
| [IM 接入](docs/im/) | 通过 Telegram / 飞书 / 微信 / 钉钉远程对话、切换项目和审批权限 |
| [Computer Use](docs/features/computer-use.md) | 计算机控制功能（截屏、鼠标、键盘）— [架构解析](docs/features/computer-use-architecture.md) |
| [全局使用](docs/guide/global-usage.md) | 在任意目录启动 CLI |
| [常见问题](docs/guide/faq.md) | 常见错误排查 |
| [项目结构](docs/reference/project-structure.md) | 代码目录结构说明 |

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript |
| 本地运行时 | [Bun](https://bun.sh) |
| 终端 UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI 解析 | Commander.js |
| 协议 | MCP, LSP |

## 感谢

感谢以下开源项目为本项目提供基础与启发：

- [React](https://github.com/facebook/react)：前端工程与组件化 UI 生态。
- [opencode](https://github.com/sst/opencode)：上游开源代码基础。
- [cc-switch](https://github.com/farion1231/cc-switch)：模型供应商配置能力参考。
