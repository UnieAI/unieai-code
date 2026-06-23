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

UnieAI Code 是一个集成 **UnieAI Studio** 的 AI 编程工作台：把会话、多项目、分支 / Worktree、右侧代码改动、代码 Diff、权限审批、模型提供商、Computer Use、H5 远程访问、IM 接入和定时任务集中到一个 macOS / Windows APP，并提供同源的命令行（CLI）。

<p align="center">
  <a href="#近期更新">近期更新</a> · <a href="#安装命令行cli">安装 CLI</a> · <a href="#桌面端预览">桌面端预览</a> · <a href="#安装桌面端">安装桌面端</a> · <a href="#更多文档">更多文档</a>
</p>

---

## 近期更新

- **npm 包瘦身 ~98%**：以前发布时会把整个源码树（含 `docs/`、`desktop/`、`packages/`、测试等）一起打包，约 **116 MB / 3200 文件**。现在改为只发布经 `bun build` 打包并压缩后的 `dist/`，约 **2.2 MB / ~340 文件**（运行时仍由 bun 执行）。`dist/` 在 `prepublishOnly` 阶段自动构建、已加入 `.gitignore`，不会提交；本地开发仍直接跑 `src/`，改动即时生效。
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
./bin/claude-haha
```

> 开发时直接从 `src/` 运行，改动即时生效。npm 发布时会通过 `prepublishOnly` 自动执行 `bun run build` 生成 `dist/`（已在 `.gitignore` 中，不会提交）。

更多配置见 [环境变量](docs/guide/env-vars.md) 和 [全局使用](docs/guide/global-usage.md)。

---

## 桌面端预览

UnieAI Code 的桌面端把会话、多项目、分支 / Worktree、右侧代码改动、代码 Diff、权限确认、提供商配置和远程入口集中到一个图形化工作台里，适合不想长期停留在终端里的日常开发工作流。

<p align="center">
  <a href="https://github.com/UnieAI/unieai-code/releases"><img src="https://img.shields.io/badge/⬇_下载桌面端-macOS_%7C_Windows-FF7A00?style=for-the-badge" alt="下载桌面端"></a>
  &nbsp;
  <a href="docs/desktop/04-installation.md"><img src="https://img.shields.io/badge/📖_安装指南-Guide-gray?style=for-the-badge" alt="安装指南"></a>
</p>

<table>
  <tr>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/10_desktop_workspace.png" alt="桌面端工作台"><br><b>桌面端工作台</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/13_workspace_changes_worktree.png" alt="右侧代码改动与 Worktree"><br><b>右侧代码改动 & Worktree</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/02_edit_code.png" alt="代码编辑"><br><b>代码编辑 & Diff 视图</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/03_ask_question_and_permission.png" alt="权限控制"><br><b>权限控制 & AI 提问</b></td>
  </tr>
  <tr>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/12_h5_access.png" alt="H5 访问"><br><b>H5 远程访问</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/11_token_usage.png" alt="Token 用量"><br><b>Token 用量统计</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/06_settings_computer_use.png" alt="Computer Use"><br><b>Computer Use</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/08_scheduled_task.png" alt="定时任务"><br><b>定时任务</b></td>
  </tr>
</table>

---

## 安装桌面端

1. 前往 [Releases](https://github.com/UnieAI/unieai-code/releases) 下载 macOS 或 Windows 桌面端安装包。
2. 首次启动后，在桌面端设置里登录 UnieAI Studio 或配置模型提供商、API Key 和默认模型。
3. 如果 macOS 提示应用无法打开，请按 [桌面端安装指南](docs/desktop/04-installation.md) 处理 Gatekeeper 权限。

---

## 桌面端亮点

- **多会话工作台**：标签页、项目切换、终端入口和会话历史集中管理。
- **分支 / Worktree 启动**：新会话可以选择仓库分支，并决定使用当前工作树还是隔离 Worktree。
- **右侧代码改动面板**：聊天时直接在右侧查看已更改文件、增删行和当前工作区状态。
- **代码修改可视化**：直接查看 AI 对文件的编辑、Diff 和执行过程。
- **权限与确认流**：危险命令、工具调用和 AI 反问可以在桌面端集中审批。
- **多模型提供商**：支持 UnieAI Studio、Anthropic 兼容 API、第三方模型和本地配置。
- **Computer Use**：让 Agent 在授权后截图、点击、输入并控制桌面应用。
- **H5 远程访问**：用一次性令牌在手机或其他设备上接入当前桌面端会话。
- **IM 接入**：通过 Telegram / 飞书 / 微信 / 钉钉远程对话、切换项目和审批权限。
- **定时任务与用量统计**：在桌面端创建计划任务，并查看本机 Token 使用趋势。

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
| [Computer Use](docs/features/computer-use.md) | 桌面控制功能（截屏、鼠标、键盘）— [架构解析](docs/features/computer-use-architecture.md) |
| [桌面端](docs/desktop/) | Tauri 2 + React 图形化客户端 — [快速上手](docs/desktop/01-quick-start.md) \| [架构设计](docs/desktop/02-architecture.md) \| [安装指南](docs/desktop/04-installation.md) |
| [全局使用](docs/guide/global-usage.md) | 在任意目录启动 CLI |
| [常见问题](docs/guide/faq.md) | 常见错误排查 |
| [项目结构](docs/reference/project-structure.md) | 代码目录结构说明 |

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript |
| 桌面 APP | Tauri 2 |
| 桌面 UI | React + Vite |
| 本地运行时 | [Bun](https://bun.sh) |
| 终端 UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI 解析 | Commander.js |
| 协议 | MCP, LSP |

## 感谢

感谢以下开源项目为本项目提供基础与启发：

- [React](https://github.com/facebook/react)：前端工程与组件化 UI 生态。
- [Tauri](https://github.com/tauri-apps/tauri)：跨端桌面应用能力与工程实践。
- [opencode](https://github.com/sst/opencode)：上游开源代码基础。
- [cc-switch](https://github.com/farion1231/cc-switch)：模型供应商配置能力参考。
