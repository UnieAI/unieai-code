#!/usr/bin/env sh
# UnieAI Code standalone installer — no npm, no bun required.
#
#   curl -fsSL https://raw.githubusercontent.com/UnieAI/unieai-code/main/install.sh | sh
#
# Downloads the prebuilt single-file binary for your OS/arch from the latest
# (or a pinned) GitHub Release and installs it to ~/.local/bin/unieai.
#
# Env overrides:
#   UNIEAI_VERSION   pin a release tag (e.g. cli-v0.0.14). Default: latest cli-v*.
#   UNIEAI_INSTALL_DIR  install location. Default: ~/.local/bin
set -eu

REPO="UnieAI/unieai-code"
INSTALL_DIR="${UNIEAI_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="unieai"

err() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$1"; }

# --- detect platform -> release asset name (must match scripts/build/compile.ts)
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os_tag="macos" ;;
  Linux)  os_tag="linux" ;;
  *) err "unsupported OS: $os (Windows: download the .exe from the Releases page)" ;;
esac
case "$arch" in
  arm64|aarch64) arch_tag="arm64" ;;
  x86_64|amd64)  arch_tag="x64" ;;
  *) err "unsupported architecture: $arch" ;;
esac
asset="${BIN_NAME}-${os_tag}-${arch_tag}"

# --- resolve tag
# The desktop app (v*) and vscode ext (vscode-v*) publish releases too, so
# `/releases/latest` may not be a CLI release. Pick the newest `cli-v*` tag.
if [ "${UNIEAI_VERSION:-}" != "" ]; then
  tag="$UNIEAI_VERSION"
else
  info "Resolving latest CLI release..."
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=100" \
    | grep '"tag_name"' | cut -d '"' -f 4 | grep '^cli-v' | head -1)"
  [ -n "$tag" ] || err "could not resolve latest cli-v* release (is one published yet?)"
fi

url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
info "Downloading ${asset} @ ${tag}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fSL --progress-bar "$url" -o "$tmp" \
  || err "download failed: $url (is asset '${asset}' attached to release ${tag}?)"

# --- install
mkdir -p "$INSTALL_DIR"
chmod +x "$tmp"
mv "$tmp" "$INSTALL_DIR/$BIN_NAME"
trap - EXIT

info "Installed to $INSTALL_DIR/$BIN_NAME"
if ! printf '%s' ":$PATH:" | grep -q ":$INSTALL_DIR:"; then
  printf '\033[33mnote:\033[0m %s is not on your PATH. Add this to your shell rc:\n' "$INSTALL_DIR"
  printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
fi
info "Run: $BIN_NAME --version"
