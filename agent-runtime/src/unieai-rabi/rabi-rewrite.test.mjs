// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import test from "node:test";
import { findLeftovers, rabiPackageName, rewritePackageNames, rewritePathSegment, rewriteText } from "./rabi-rewrite.mjs";

test("package scopes and names", () => {
  assert.equal(rabiPackageName("@deepseek-ai/dsh"), "@unieai/rabi");
  assert.equal(rabiPackageName("@deepseek-ai/dsh-session"), "@unieai/rabi-session");
  assert.equal(rabiPackageName("@deepseek-ai/cordis"), "@unieai/cordis");
  assert.equal(rewriteText(`import { x } from "@deepseek-ai/dsh-client-store";`), `import { x } from "@unieai/rabi-client-store";`);
  assert.equal(rewriteText("const publicRepository = 'deepseek-ai/dsh-libreoffice-kit';"), "const publicRepository = 'UnieAI/rabi-libreoffice-kit';");
  assert.equal(rewriteText("repository `deepseek-ai/deepseek-harness`"), "repository `UnieAI/rabi-harness`");
  assert.equal(rewriteText("(Join-Path $env:APPDATA '@deepseek-ai\\dsh-desktop')"), "(Join-Path $env:APPDATA '@unieai\\rabi-desktop')");
  assert.equal(rewriteText("from deepseek_harness import DeepSeekHarness"), "from rabi_harness import RabiHarness");
  // Other deepseek-ai/ slugs are model ids and stay as they are.
  assert.equal(rewriteText("deepseek-ai/DeepSeek-V3.2"), "deepseek-ai/DeepSeek-V3.2");
});

test("name segments in every case", () => {
  const cases = {
    "dsh": "rabi",
    "dsh-session": "rabi-session",
    "DSH_HOME": "RABI_HOME",
    "$DSH_HOME/cordis.patch.yml": "$RABI_HOME/cordis.patch.yml",
    "resolveDshHome": "resolveRabiHome",
    "getDshRuntimeVersion": "getRabiRuntimeVersion",
    "DshEnvironment": "RabiEnvironment",
    "--dsh-content-font-size": "--rabi-content-font-size",
    "__dsh_shell_idle": "__rabi_shell_idle",
    "__DSH_BOOT__": "__RABI_BOOT__",
    "isDSHRemoteError": "isRABIRemoteError",
    "DSHInspector.getSources": "RABIInspector.getSources",
    "_deepseek_ai_dsh_client_ui_primitives.Button": "_unieai_rabi_client_ui_primitives.Button",
    "engines.dsh": "engines.rabi",
    "~/.dsh/skills": "~/.rabi/skills",
    "dsh-resource://file": "rabi-resource://file",
    "line one\\ndsh plugin": "line one\\nrabi plugin",
    "Restart DSH to apply": "Restart RABI to apply",
    "https://github.com/deepseek-ai/deepseek-harness.git": "https://github.com/UnieAI/rabi-harness.git",
    "https://github.com/deepseek-ai/dsh-libreoffice-kit": "https://github.com/UnieAI/rabi-libreoffice-kit",
    "DeepSeek Harness": "Rabi Harness",
    "/name: '@deepseek-ai\\/dsh-experimental-worktree'/": "/name: '@unieai\\/rabi-experimental-worktree'/",
    "docs#deepseek-ai-dsh-tool-web/summary": "docs#unieai-rabi-tool-web/summary",
    "config-catalog.md#deepseek-aidsh-credentials-local": "config-catalog.md#unieairabi-credentials-local",
  };
  for (const [from, to] of Object.entries(cases)) assert.equal(rewriteText(from), to, from);
});

test("words that only contain the letters are kept", () => {
  for (const word of [
    "spreadsheet", "Spreadsheets", "spreadsheetml", "SpreadsheetML", "handshake", "WebSocketSendHandshakeRequest",
    "WEB_SOCKET_SEND_HANDSHAKE_REQUEST", "$ZodShape", "extendShape", "threedshadow", "addSheet", "boundsHeight",
    "xn--krdsherad-m8a", "krodsherad", "dshow",
  ]) {
    assert.equal(rewriteText(word), word, word);
  }
});

test("base64 runs are data and stay byte-identical", () => {
  const blob = "QeeRAOX2lkLvr5dXOpTqRWtp0p9ytL5PpFgQnfcOyWwyZsKRr0yQt8J0zSFKzFPgAXZHPM9WimX54o8cb2Cdsh6ZUedIfG" +
    "ISdshCFXYapjLoROhvoioczssWMFIlCywU2HwXXhP4Ak0Tt5mJWZDylB5zd9g4S6snoutuJnop8cMdshH5674Pz1ke";
  const text = `url("data:font/woff2;base64,${blob}") /* dsh-font */`;
  assert.equal(rewriteText(text), `url("data:font/woff2;base64,${blob}") /* rabi-font */`);
  assert.deepEqual(findLeftovers(rewriteText(text)), []);
});

test("path segments", () => {
  assert.equal(rewritePathSegment("dsh-badge.md"), "rabi-badge.md");
  assert.equal(rewritePathSegment("_dsh-devtools_empty-BvRk9kiK.js"), "_rabi-devtools_empty-BvRk9kiK.js");
  assert.equal(rewritePathSegment("spreadsheet.js"), "spreadsheet.js");
});

test("user data keeps everything but package names", () => {
  const line = `{"plugin":"@deepseek-ai/dsh-system-prompt","text":"see /home/ubuntu/dsh/AGENTS.md and DSH_HOME"}`;
  assert.equal(rewritePackageNames(line), `{"plugin":"@unieai/rabi-system-prompt","text":"see /home/ubuntu/dsh/AGENTS.md and DSH_HOME"}`);
});

test("leftovers are found", () => {
  assert.equal(findLeftovers("all rabi here, spreadsheet ok").length, 0);
  assert.ok(findLeftovers("oops DSH_HOME").length > 0);
  assert.ok(findLeftovers("from @deepseek-ai/cordis").length > 0);
  assert.ok(findLeftovers("/deepseek-ai-cordis/summary").length > 0);
});
