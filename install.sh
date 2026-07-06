#!/usr/bin/env sh
# UnieAI Code standalone installer — no npm, no bun required.
#
#   curl -fsSL https://raw.githubusercontent.com/UnieAI/Unieai-Code-Publish/main/install.sh | sh
#
# Downloads the prebuilt single-file binary for your OS/arch from the latest
# (or a pinned) GitHub Release and installs it to ~/.local/bin/unieai.
#
# NOTE: this points at the PUBLIC distribution repo (UnieAI/Unieai-Code-Publish),
# not the private source repo. The release CI in the source repo builds the
# binaries and pushes them (plus this script) to the public repo, so the curl
# one-liner works without any auth. This file is the source of truth; CI mirrors
# it to the public repo on each release.
#
# Env overrides:
#   UNIEAI_VERSION   pin a release tag (e.g. cli-v0.0.14). Default: latest cli-v*.
#   UNIEAI_INSTALL_DIR  install location. Default: ~/.local/bin
set -eu

REPO="UnieAI/Unieai-Code-Publish"
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

# --- resolve download URL
# Use GitHub's release-asset redirects instead of the api.github.com REST API.
# The REST API is rate-limited to 60 req/hr for unauthenticated callers and
# returns 403 once that's hit; the redirect endpoints have no such limit. Since
# this public repo holds ONLY cli-v* releases, `releases/latest` is always the
# CLI, so we can point straight at `releases/latest/download/<asset>`.
if [ "${UNIEAI_VERSION:-}" != "" ]; then
  tag="$UNIEAI_VERSION"
  url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
else
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
  # Best-effort: read the tag from the /releases/latest redirect, for display
  # only. Never fatal — the download above does not depend on it.
  tag="$(curl -fsS -o /dev/null -w '%{redirect_url}' \
    "https://github.com/${REPO}/releases/latest" 2>/dev/null \
    | sed -n 's#.*/releases/tag/##p')"
  [ -n "$tag" ] || tag="latest"
fi

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
