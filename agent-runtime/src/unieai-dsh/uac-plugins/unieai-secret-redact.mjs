// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-secret-redact.mjs — keep this machine's own credentials out of what
 * the model reads.
 *
 * A system prompt that says "do not print secrets" is not enough: a model
 * debugging a registry problem ran `cat ~/.npmrc` and put an npm publish token
 * into its context and the model request. This plugin rewrites every tool
 * result on `tools/post-execute`, after all other policies, and replaces known
 * credential values with `[redacted: <what it was>]`.
 *
 * Only exact values that are credentials of this machine are redacted, never
 * patterns. Pattern matching ("anything that looks like a token") would also
 * hide git SHAs, hashes, UUIDs and base64 data, and the secrets a task asks the
 * agent to find (a key hidden in a binary, a leaked password in git history),
 * which are not this machine's credentials. The values come from:
 *
 *   - environment variables whose names say they hold a credential
 *     (TOKEN, SECRET, PASSWORD, API_KEY, ACCESS_KEY, PRIVATE_KEY, CREDENTIAL, AUTH);
 *   - .npmrc files (`_authToken`, `_auth`, `_password`): npm's user config
 *     setting, ~/.npmrc and the working directory's, ~/.git-credentials,
 *     ~/.docker/config.json, ~/.config/gh/hosts.yml, ~/.netrc,
 *     ~/.aws/credentials, ~/.pypirc;
 *   - UnieAI's unieai.json (gateway key, access and refresh tokens) in
 *     $UNIEAI_HOME / $CODEX_HOME / ~/.unieai, and dsh's credential store
 *     ($DSH_HOME/.credentials.yaml);
 *   - config `values` ([{ value, label }] or strings).
 *
 * Only the model-facing content changes: commands and tools still run with
 * the real values, and the tool's `value` is untouched. Files are re-read
 * when they change (checked at most every `refreshMs`). A credential split
 * across two results (streamed output read in two polls) is caught by
 * redacting a leading suffix or trailing prefix of at least `minPartial`
 * characters. Values shorter than `minLength` are ignored; they are too
 * likely to occur in ordinary output.
 *
 * Nested calls (inside run_code) are left alone: their content goes to the
 * program, and the program's own result is redacted.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const name = "unieai-secret-redact";

export const DEFAULTS = Object.freeze({ minLength: 12, minPartial: 8, refreshMs: 30_000 });

/** Environment variable names that hold credentials. */
export const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|(^|_)AUTH($|_))/i;

export const marker = (label) => `[redacted: ${label}]`;

const readText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const decodeBase64 = (text) => {
  try {
    return Buffer.from(text, "base64").toString("utf8");
  } catch {
    return "";
  }
};

/** A plausible secret value: long enough, not a path, not a plain word or number. */
function candidate(value, minLength) {
  const text = String(value ?? "").trim().replace(/^["']|["']$/g, "");
  if (text.length < minLength) return null;
  if (/^[/~.]/.test(text) || /^https?:\/\/[^@]*$/.test(text)) return null;
  if (/^(true|false|yes|no|null|undefined)$/i.test(text) || /^\d+$/.test(text)) return null;
  return text;
}

/** The account's home from the password database, whatever $HOME says. */
export function accountHome() {
  try {
    return userInfo().homedir || null;
  } catch {
    return null;
  }
}

/**
 * The files to read. Every home counts: $HOME can point elsewhere (a test, a
 * sandbox, a wrapper), but the model can still read the account's real home
 * by path, and did.
 */
export function sourcesFrom(env = process.env, cwd = process.cwd(), realHome = accountHome()) {
  const homes = [...new Set([env.HOME, realHome, homedir()].filter(Boolean))];
  const inHomes = (...parts) => homes.map((home) => join(home, ...parts));
  const uniq = (paths) => [...new Set(paths.filter(Boolean))];
  return {
    homes,
    // All of them: npm scripts set npm_config_userconfig, and a token can
    // sit in any file npm reads.
    npmrc: uniq([env.NPM_CONFIG_USERCONFIG, env.npm_config_userconfig, ...inHomes(".npmrc"), join(cwd, ".npmrc")]),
    gitCredentials: inHomes(".git-credentials"),
    docker: uniq([env.DOCKER_CONFIG && join(env.DOCKER_CONFIG, "config.json"), ...inHomes(".docker", "config.json")]),
    gh: uniq([env.GH_CONFIG_DIR && join(env.GH_CONFIG_DIR, "hosts.yml"), ...inHomes(".config", "gh", "hosts.yml")]),
    netrc: inHomes(".netrc"),
    aws: uniq([env.AWS_SHARED_CREDENTIALS_FILE, ...inHomes(".aws", "credentials")]),
    pypirc: inHomes(".pypirc"),
    unieai: uniq([env.UNIEAI_HOME, env.CODEX_HOME, ...inHomes(".unieai")].map((dir) => dir && join(dir, "unieai.json"))),
    dshCredentials: env.DSH_HOME ? [join(env.DSH_HOME, ".credentials.yaml")] : [],
  };
}

/**
 * Every known credential value, as [value, label] pairs, longest first.
 * Pure given `read` (path -> text or null) and `env`.
 */
export function collectSecrets({ env = process.env, read = readText, extra = [], minLength = DEFAULTS.minLength, realHome = accountHome() } = {}) {
  const found = new Map();
  const add = (value, label) => {
    const text = candidate(value, minLength);
    if (text && !found.has(text)) found.set(text, label);
  };
  const src = sourcesFrom(env, process.cwd(), realHome);
  const readAll = (paths) => paths.map((path) => read(path)).filter((text) => typeof text === "string").join("\n");

  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV.test(key)) add(value, `environment variable ${key}`);
  }

  const npmLines = src.npmrc.flatMap((path) => read(path)?.split(/\r?\n/) ?? []);
  for (const line of npmLines) {
    const match = line.match(/(?:^|:)(_authToken|_auth|_password)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    add(match[2], "npm token");
    if (match[1] !== "_authToken") add(decodeBase64(match[2]).split(":").pop(), "npm password");
  }

  for (const line of readAll(src.gitCredentials).split(/\r?\n/)) {
    const match = line.trim().match(/^[a-z][a-z0-9+.-]*:\/\/[^:@/]*:([^@]+)@/i);
    if (match) add(decodeURIComponent(match[1]), "git credential");
  }

  for (const path of src.docker) {
    try {
      const docker = JSON.parse(read(path) ?? "null");
      for (const entry of Object.values(docker?.auths ?? {})) {
        if (entry?.auth) {
          add(entry.auth, "container registry credential");
          add(decodeBase64(entry.auth).split(":").slice(1).join(":"), "container registry password");
        }
        if (entry?.identitytoken) add(entry.identitytoken, "container registry token");
      }
    } catch {
      // Not JSON: nothing to take.
    }
  }

  for (const match of readAll(src.gh).matchAll(/^\s*oauth_token:\s*(\S+)\s*$/gm)) add(match[1], "GitHub CLI token");
  for (const match of readAll(src.netrc).matchAll(/\bpassword\s+(\S+)/g)) add(match[1], "netrc password");
  for (const match of readAll(src.aws).matchAll(/^\s*(aws_secret_access_key|aws_session_token)\s*=\s*(\S+)\s*$/gim)) {
    add(match[2], "AWS credential");
  }
  for (const match of readAll(src.pypirc).matchAll(/^\s*password\s*[=:]\s*(\S+)\s*$/gim)) add(match[1], "PyPI password");

  for (const path of src.unieai) {
    try {
      const account = JSON.parse(read(path) ?? "null");
      if (!account) continue;
      add(account.gateway_api_key ?? account.gatewayApiKey, "UnieAI gateway key");
      add(account.access_token ?? account.accessToken, "UnieAI access token");
      add(account.refresh_token ?? account.refreshToken, "UnieAI refresh token");
    } catch {
      // Not JSON.
    }
  }
  for (const path of src.dshCredentials) {
    for (const match of read(path)?.matchAll(/^\s+([A-Za-z0-9_]+):\s*("(?:[^"\\]|\\.)*"|\S+)\s*$/gm) ?? []) {
      let value = match[2];
      try {
        value = value.startsWith('"') ? JSON.parse(value) : value;
      } catch {
        // Keep the raw text.
      }
      add(value, `credential ${match[1]}`);
    }
  }

  for (const item of extra) {
    if (typeof item === "string") add(item, "configured secret");
    else if (item && typeof item === "object") add(item.value, item.label || "configured secret");
  }
  return [...found.entries()].sort((a, b) => b[0].length - a[0].length);
}

/**
 * `text` with every known value replaced. A trailing prefix or leading suffix
 * of a value (at least `minPartial` characters) is a value split across two
 * results and is replaced too.
 */
export function redactText(text, secrets, { minPartial = DEFAULTS.minPartial } = {}) {
  if (typeof text !== "string" || !text || secrets.length === 0) return text;
  let out = text;
  for (const [value, label] of secrets) {
    if (out.includes(value)) out = out.split(value).join(marker(label));
  }
  for (const [value, label] of secrets) {
    for (let size = value.length - 1; size >= minPartial; size -= 1) {
      if (out.endsWith(value.slice(0, size))) {
        out = out.slice(0, out.length - size) + marker(`${label}, cut off`);
        break;
      }
    }
    for (let size = value.length - 1; size >= minPartial; size -= 1) {
      if (out.startsWith(value.slice(value.length - size))) {
        out = marker(`${label}, continued`) + out.slice(size);
        break;
      }
    }
  }
  return out;
}

/** Content blocks with their text redacted; null when nothing changed. */
export function redactContent(content, secrets, options) {
  if (!Array.isArray(content)) return null;
  let changed = false;
  const next = content.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const text = redactText(block.text, secrets, options);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? next : null;
}

/** File modification times of every source, to know when to re-read. */
function fingerprint(env) {
  const src = sourcesFrom(env);
  const paths = [...src.npmrc, ...src.gitCredentials, ...src.docker, ...src.gh, ...src.netrc, ...src.aws, ...src.pypirc, ...src.unieai, ...src.dshCredentials];
  return paths
    .map((path) => {
      try {
        return `${path}:${statSync(path).mtimeMs}`;
      } catch {
        return `${path}:-`;
      }
    })
    .join("|");
}

export function apply(ctx, config = {}, { env = process.env, read = readText, now = () => Date.now() } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const extra = Array.isArray(cfg.values) ? cfg.values : [];
  let secrets = collectSecrets({ env, read, extra, minLength: cfg.minLength });
  let print = fingerprint(env);
  let checkedAt = now();
  const current = () => {
    if (now() - checkedAt < cfg.refreshMs) return secrets;
    checkedAt = now();
    const next = fingerprint(env);
    if (next !== print) {
      print = next;
      secrets = collectSecrets({ env, read, extra, minLength: cfg.minLength });
    }
    return secrets;
  };
  ctx.logger?.info?.(`${name}: watching ${secrets.length} credential value(s)`);

  ctx.on(
    "tools/post-execute",
    async (exec, result, next) => {
      const decision = await next();
      if (exec?.parent !== undefined || decision?.kind !== "accept") return decision;
      const known = current();
      if (known.length === 0) return decision;
      // A replaced value is re-rendered by its tool after this hook; its
      // content cannot be rewritten here, so leave it (no policy does this
      // with credential-bearing output today).
      if (Object.hasOwn(decision, "value")) return decision;
      const options = { minPartial: cfg.minPartial };
      const content = redactContent(decision.content ?? result?.content, known, options);
      const contexts = Array.isArray(decision.additionalContexts)
        ? decision.additionalContexts.map((item) => (typeof item === "string" ? redactText(item, known, options) : item))
        : undefined;
      const contextsChanged = contexts?.some((item, index) => item !== decision.additionalContexts[index]);
      if (!content && !contextsChanged) return decision;
      ctx.logger?.info?.(`${name}: redacted credential text from ${exec?.name ?? "a tool"} output`);
      return {
        ...decision,
        ...(content ? { content } : {}),
        ...(contextsChanged ? { additionalContexts: contexts } : {}),
      };
    },
    // Outermost: see the content after every other policy has rewritten it.
    { prepend: true },
  );
}
