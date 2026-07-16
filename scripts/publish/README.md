# UnieAI Code — CLI 下載 / Downloads

UnieAI Code 是一个集成 **UnieAI Studio** 的 AI 命令行编程工具（CLI）。

本仓库是 **公开发布门面**：只提供预编译的单文件可执行档与安装脚本，源码位于私有仓库。
This is the **public distribution repo** — it hosts the prebuilt single-file binaries and the installer only. The source lives in a private repository.

---

## 一键安装 / One-line install (macOS · Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/UnieAI/Unieai-Code-Publish/main/install.sh | sh
```

- 免 npm、免 bun：脚本会下载对应你系统的单文件二进制，安装到 `~/.local/bin/unieai`。
- No npm, no bun required — the script downloads the right single-file binary for your OS/arch into `~/.local/bin/unieai`.

安装后验证 / Verify:

```sh
unieai --version
```

若提示 `unieai` 不在 PATH，请把安装目录加进 shell rc / If it's not on PATH, add the install dir to your shell rc:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

### 可选环境变量 / Optional env vars

| 变量 | 说明 |
|---|---|
| `UNIEAI_VERSION` | 锁定某个版本，例如 `cli-v0.0.14`（默认取最新 `cli-v*`）。Pin a release tag. |
| `UNIEAI_INSTALL_DIR` | 安装位置（默认 `~/.local/bin`）。Install location. |

例 / Example:

```sh
UNIEAI_VERSION=cli-v0.0.14 curl -fsSL https://raw.githubusercontent.com/UnieAI/Unieai-Code-Publish/main/install.sh | sh
```

---

## Windows

请到 [Releases](https://github.com/UnieAI/Unieai-Code-Publish/releases) 页面下载 `unieai-windows-x64.exe`，放到 PATH 上的目录即可。
Download `unieai-windows-x64.exe` from the [Releases](https://github.com/UnieAI/Unieai-Code-Publish/releases) page and place it on your PATH.

---

## 手动下载 / Manual download

到 [Releases](https://github.com/UnieAI/Unieai-Code-Publish/releases) 挑选对应平台的档案：

| 平台 / Platform | 档案 / Asset |
|---|---|
| macOS (Apple Silicon) | `unieai-macos-arm64` |
| macOS (Intel) | `unieai-macos-x64` |
| Linux (x86_64) | `unieai-linux-x64` |
| Linux (arm64) | `unieai-linux-arm64` |
| Windows (x64) | `unieai-windows-x64.exe` |

下载后 / After downloading (macOS/Linux):

```sh
chmod +x unieai-macos-arm64
mv unieai-macos-arm64 ~/.local/bin/unieai
unieai --version
```

---

> 二进制由源码仓库的 CI 自动构建并发布至此。请勿手动编辑本仓库内容——`install.sh` 与本 README 会在每次发版时由 CI 覆盖同步。
> Binaries are built and published here automatically by the source repo's CI. Do not hand-edit this repo — `install.sh` and this README are overwritten on each release.
