// Copyright (c) 2026 UnieAI. All rights reserved.
// dsh's DeepSeek service rows stay off in every uac mode, and a dsh upgrade
// that adds one fails here until it is reviewed and listed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DEEPSEEK_ROWS_OFF, UAC_MODES, renderPatch } from "./config.mjs";

const require = createRequire(import.meta.url);
const packageDir = (name) => dirname(require.resolve(`${name}/package.json`));

/** Rows that mention DeepSeek but must stay on, with why. */
const KEPT = {
  // The multi-provider adapter uac's gateway and connected servers run on; its
  // DeepSeek host is one built-in preset that uac's settings never select.
  "llm-pi-ai": "uac's own provider adapter",
};

const DEEPSEEK_HOST = /deepseek\.com|deepseek\.cn|deepseeksvc\.com/;

function sourceReachesDeepSeek(dir) {
  const stack = [join(dir, "lib")];
  while (stack.length) {
    const at = stack.pop();
    let entries;
    try {
      entries = readdirSync(at);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) stack.push(path);
      else if (/\.[cm]?js$/.test(entry) && DEEPSEEK_HOST.test(readFileSync(path, "utf8"))) return true;
    }
  }
  return false;
}

test("every uac mode turns the DeepSeek service rows off", () => {
  for (const mode of UAC_MODES) {
    const patch = renderPatch({ defaultModel: "m", mode, home: "/tmp/unieai-home" });
    for (const id of DEEPSEEK_ROWS_OFF) {
      assert.ok(patch.includes(`- id: ${id}\n  disabled: true\n`), `${mode}: ${id} is not disabled`);
    }
  }
});

test("dsh-base has no DeepSeek or telemetry row uac leaves on", () => {
  const base = readFileSync(join(packageDir("@deepseek-ai/dsh-base"), "cordis.patch.yml"), "utf8");
  const rows = [...base.matchAll(/- id: (\S+)\n\s+name: '([^']+)'/g)].map(([, id, name]) => ({ id, name }));
  assert.ok(rows.length > 50, "dsh-base rows were not found; the patch format changed");
  const unreviewed = rows
    .filter(({ id, name }) => {
      if (KEPT[id] || DEEPSEEK_ROWS_OFF.includes(id)) return false;
      if (/deepseek|telemetry/i.test(id) || /deepseek-(?!ai\/)|telemetry/i.test(name)) return true;
      try {
        return sourceReachesDeepSeek(packageDir(name.split("/").slice(0, 2).join("/")));
      } catch {
        return false;
      }
    })
    .map(({ id, name }) => `${id} (${name})`);
  assert.deepEqual(unreviewed, [], "rows that reach DeepSeek: turn them off in DEEPSEEK_ROWS_OFF or list them in KEPT");
  for (const id of DEEPSEEK_ROWS_OFF) {
    assert.ok(rows.some((row) => row.id === id), `${id} is gone from dsh-base; drop it from DEEPSEEK_ROWS_OFF`);
  }
});
