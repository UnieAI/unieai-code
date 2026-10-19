// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-agents.mjs — user-defined subagents from markdown files.
 *
 * Claude Code-style agent definitions: a markdown file whose YAML frontmatter
 * names the agent and whose body is its system prompt.
 *
 *   ---
 *   name: code-reviewer
 *   description: Reviews a diff for correctness bugs. Use after a change.
 *   tools: Read, Grep, Glob        # optional allowlist; omitted = every tool
 *   model: some-model-id           # optional; omitted or `inherit` = the parent's
 *   ---
 *   You are a senior reviewer. ...
 *
 * Read from (first definition of a name wins):
 *   <dir>/.unieai/agents/*.md, then <dir>/.claude/agents/*.md, for each
 *     directory from the session's cwd up to its git root (nearest first);
 *   <home>/agents/*.md (home = $UNIEAI_HOME / $CODEX_HOME / ~/.unieai);
 *   ~/.claude/agents/*.md.
 * The `.claude` directories are read so definitions written for Claude Code
 * work unchanged (`claude: false` turns that off). Codex's own agent roles in
 * `.unieai/agents/*.toml` belong to the codex engine and are not read here.
 *
 * dsh's agent presets could carry a persona and a tool set, but a preset is a
 * whole composition and uac runs dsh's flat ACP profile, so this plugin does
 * the three things directly on the child it starts:
 *
 * - The main agent's `subagent` tool is shadowed, in that agent's own scope,
 *   by the same tool with an `agent` parameter listing each definition's name
 *   and description. A call without `agent` is dsh's call, unchanged; with
 *   one, the child starts through the same subagent service with the
 *   definition's model as its route.
 * - When the child is created its scope gets the body as its persona (the
 *   `deployment:persona-prefix` section, so it replaces the UnieAI persona as
 *   Claude Code's body replaces its default prompt; tool guidance and runtime
 *   context stay) and `tools.restrict({ allow })` from the tool list.
 * - The resolved definition is logged in the child's session as a plugin
 *   record, so a child resumed after a restart gets the same prompt and tools.
 *
 * Tool names from Claude Code (Read, Edit, Bash, ...) map to their dsh/UnieAI
 * equivalents; native names pass through; names this deployment does not have
 * are dropped. Definitions are read when a session's agent is created (and
 * re-read at each spawn, so prompt edits apply to the next child); a new file
 * shows in the tool from the next session.
 */
import { readdirSync, readFileSync, realpathSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import { parentAgentOptionsForDelegation } from "@deepseek-ai/dsh-subagent";

export const name = "unieai-agents";
export const inject = ["tools", "agents", "subagents", "systemPrompt"];

export const DEFAULTS = Object.freeze({ toolName: "subagent", provider: "spawn", maxAgents: 64, maxPromptBytes: 65_536 });

/** The session plugin record holding a child's resolved definition. */
export const RECORD_TYPE = "plugin:unieai-agents/definition";

/** Claude Code's tool names -> the names they mean here (whichever exist). */
export const TOOL_ALIASES = Object.freeze({
  read: ["read", "read_image", "describe_image"],
  write: ["write"],
  edit: ["edit", "apply_patch"],
  multiedit: ["edit", "apply_patch"],
  notebookedit: ["edit"],
  bash: ["exec_command", "write_stdin", "bash", "pwsh", "job_output", "job_wait", "job_kill", "job_list", "working_directory"],
  bashoutput: ["write_stdin", "job_output", "job_wait"],
  killshell: ["job_kill"],
  glob: ["glob"],
  ls: ["glob"],
  grep: ["grep"],
  webfetch: ["web_fetch"],
  websearch: ["web_search"],
  todowrite: ["todo_write"],
  skill: ["skill"],
});

/** Claude Code's model aliases: no UnieAI gateway serves these names. */
const CLAUDE_MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "opusplan"]);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function unieaiHome(env = process.env) {
  return resolve(env.UNIEAI_HOME || env.CODEX_HOME || join(homedir(), ".unieai"));
}

/**
 * Parse one definition file. Returns `{ definition }` or `{ warning }`.
 * `fallbackName` (the file's basename) is used when the frontmatter has none.
 */
export function parseAgentFile(text, { path = "<agent>", fallbackName } = {}) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { warning: `${path}: no YAML frontmatter (--- ... ---)` };
  let meta;
  try {
    meta = parseYaml(match[1]) ?? {};
  } catch (error) {
    return { warning: `${path}: frontmatter is not valid YAML: ${error.message}` };
  }
  if (typeof meta !== "object" || Array.isArray(meta)) return { warning: `${path}: frontmatter is not a mapping` };
  const agentName = String(meta.name ?? fallbackName ?? "").trim();
  if (!NAME_RE.test(agentName)) return { warning: `${path}: name "${agentName}" must be letters, digits, '-', '_' or '.'` };
  const description = typeof meta.description === "string" ? meta.description.trim().replace(/\s+/g, " ") : "";
  if (!description) return { warning: `${path}: description is required` };
  const prompt = match[2].trim();
  if (!prompt) return { warning: `${path}: the body (the agent's system prompt) is empty` };
  const tools = parseToolList(meta.tools);
  const model = typeof meta.model === "string" && meta.model.trim() && meta.model.trim() !== "inherit" ? meta.model.trim() : undefined;
  return { definition: { name: agentName, description, prompt, ...(tools ? { tools } : {}), ...(model ? { model } : {}), path } };
}

/** `tools:` as a comma/space list or a YAML sequence; undefined = every tool. */
export function parseToolList(value) {
  if (value === undefined || value === null) return undefined;
  const items = Array.isArray(value) ? value.map(String) : String(value).split(/[,\s]+/);
  const names = items.map((item) => item.trim()).filter(Boolean);
  if (names.length === 0 || names.includes("*")) return undefined;
  return [...new Set(names)];
}

/** The directories definitions are read from, highest precedence first. */
export function agentDirs({ cwd, home = unieaiHome(), claudeHome = join(homedir(), ".claude"), claude = true } = {}) {
  const projectDirs = claude ? [".unieai", ".claude"] : [".unieai"];
  const dirs = [];
  if (cwd) {
    // Nearest first, up to the git root (or only cwd outside a repository).
    const levels = [];
    let dir = resolve(cwd);
    for (;;) {
      levels.push(dir);
      if (existsSync(join(dir, ".git"))) break;
      const up = dirname(dir);
      if (up === dir) {
        levels.splice(1);
        break;
      }
      dir = up;
    }
    for (const level of levels) for (const project of projectDirs) dirs.push(join(level, project, "agents"));
  }
  dirs.push(join(home, "agents"));
  if (claude) dirs.push(join(claudeHome, "agents"));
  return dirs;
}

/**
 * Load every definition visible from `cwd`: `{ agents: Map<name, def>, warnings }`.
 * A directory reached twice (e.g. cwd is the home directory) is read once.
 */
export function loadAgentDefinitions(options = {}) {
  const { maxAgents = DEFAULTS.maxAgents, maxPromptBytes = DEFAULTS.maxPromptBytes } = options;
  const agents = new Map();
  const warnings = [];
  const seen = new Set();
  for (const dir of agentDirs(options)) {
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let files;
    try {
      files = readdirSync(real).filter((file) => file.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(dir, file);
      let text;
      try {
        if (!statSync(path).isFile()) continue;
        text = readFileSync(path, "utf8");
      } catch (error) {
        warnings.push(`${path}: ${error.message}`);
        continue;
      }
      if (Buffer.byteLength(text) > maxPromptBytes) {
        warnings.push(`${path}: larger than ${maxPromptBytes} bytes; skipped`);
        continue;
      }
      const { definition, warning } = parseAgentFile(text, { path, fallbackName: basename(file, ".md") });
      if (warning) warnings.push(warning);
      if (!definition || agents.has(definition.name)) continue;
      if (agents.size >= maxAgents) {
        warnings.push(`more than ${maxAgents} agent definitions; ${path} and later ones skipped`);
        return { agents, warnings };
      }
      agents.set(definition.name, definition);
    }
  }
  return { agents, warnings };
}

/**
 * The tool names `requested` allows among `available`: aliases expanded,
 * case-insensitive. Returns `{ allow, unknown }`.
 */
export function resolveToolAllowlist(requested, available) {
  const byLower = new Map([...available].map((tool) => [tool.toLowerCase(), tool]));
  const allow = new Set();
  const unknown = [];
  for (const raw of requested) {
    // Claude Code's `Bash(git:*)`-style argument patterns: the tool is what counts here.
    const name = raw.replace(/\(.*\)$/, "").trim();
    const lower = name.toLowerCase();
    const direct = byLower.get(lower);
    const aliased = (TOOL_ALIASES[lower] ?? []).map((alias) => byLower.get(alias)).filter(Boolean);
    if (direct) allow.add(direct);
    for (const tool of aliased) allow.add(tool);
    if (!direct && aliased.length === 0) unknown.push(name);
  }
  return { allow: [...allow], unknown };
}

/** The `agent` parameter's description: one line per definition. */
export function agentParameterDescription(agents) {
  const lines = [...agents.values()].map((agent) => `- ${agent.name}: ${agent.description}`);
  return [
    "A user-defined agent to run this task. Omit for a general-purpose subagent. The named agent has its own instructions (and may be limited to certain tools), so the prompt still needs the complete task. Available agents:",
    ...lines,
  ].join("\n");
}

/** The shadowing tool: `base` with the `agent` parameter added. */
export function withAgentParameter(base, agents, spawnDefined) {
  const names = [...agents.keys()];
  const listing = [...agents.values()].map((agent) => `${agent.name} (${agent.description})`).join("; ");
  return {
    ...base,
    description: `${base.description} Specialised agents defined for this project can be chosen with \`agent\`: ${listing}. Use one when the task matches its description.`,
    parameters: {
      ...base.parameters,
      properties: {
        ...base.parameters?.properties,
        agent: { type: "string", enum: names, description: agentParameterDescription(agents) },
      },
    },
    async execute(args, exec) {
      if (args?.agent === undefined || args.agent === null || args.agent === "") {
        const { agent: _omitted, ...rest } = args ?? {};
        return base.execute(rest, exec);
      }
      return spawnDefined(args, exec);
    },
  };
}

/** The definition a resumed child started with, from its own log; undefined for any other. */
export function recordedDefinition(session) {
  let record;
  for (const event of session?.snapshotEvents?.() ?? []) {
    const found = pluginRecordOf(event);
    if (found?.type === RECORD_TYPE && typeof found.data?.prompt === "string") record = found.data;
  }
  return record;
}

/** A definition as recorded in the child's session (what the child runs with). */
const snapshot = (definition, allow) => ({
  name: definition.name,
  prompt: definition.prompt,
  ...(allow ? { allow } : {}),
  ...(definition.path ? { path: definition.path } : {}),
});

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig };
  const home = config.home ?? unieaiHome();
  const loadOptions = { home, claude: config.claude !== false, maxAgents: config.maxAgents, maxPromptBytes: config.maxPromptBytes };
  if (config.claudeHome) loadOptions.claudeHome = config.claudeHome;
  const pending = new Map(); // child id -> snapshot, until the child is created
  const installed = new WeakSet();

  const globalToolNames = () => new Set(ctx.tools.schemas().map((schema) => schema.name));

  /** Give a just-created child its definition's prompt and tool set. */
  const applyToChild = (agent, record) => {
    agent.ctx.systemPrompt.section({
      name: "deployment:persona-prefix",
      order: agent.ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
      text: record.prompt,
      interpolate: false,
    });
    if (record.allow?.length) {
      const known = globalToolNames();
      const allow = record.allow.filter((tool) => known.has(tool));
      // restrict() rejects an empty or unknown-name filter; a tool that has
      // since gone away leaves the rest. If none is left, the child gets none.
      if (allow.length > 0) agent.ctx.tools.restrict({ allow });
      else agent.ctx.tools.restrict({ deny: [...known] });
    }
  };

  const spawnDefined = async (args, exec, cwd) => {
    const parent = exec.agent;
    if (!parent) throw new Error("subagent tool requires a calling agent");
    if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("`prompt` is required");
    if (typeof args.description !== "string" || !args.description.trim()) throw new Error("`description` is required");
    // Re-read so an edited prompt applies to this child.
    const { agents } = loadAgentDefinitions({ ...loadOptions, cwd });
    const definition = agents.get(args.agent);
    if (!definition) throw new Error(`no agent named "${args.agent}"; available: ${[...agents.keys()].join(", ") || "(none)"}`);
    let allow;
    if (definition.tools) {
      const resolved = resolveToolAllowlist(definition.tools, globalToolNames());
      if (resolved.unknown.length > 0) ctx.logger.info(`${name}: ${definition.name}: tools not available here: ${resolved.unknown.join(", ")}`);
      if (resolved.allow.length === 0) {
        throw new Error(`agent "${definition.name}" may only use ${definition.tools.join(", ")}, and none of those tools exist here; fix \`tools:\` in ${definition.path}`);
      }
      allow = resolved.allow;
    }
    const notes = [];
    const agentOptions = await resolveModel(ctx, parent, definition, exec.signal, notes);
    const childId = randomUUID();
    pending.set(childId, snapshot(definition, allow));
    try {
      const maxDepth = ctx.subagents.resolveMaxDepth(undefined);
      const request = {
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        prompt: [{ type: "text", text: args.prompt }],
        parent,
        ...(agentOptions ? { agentOptions } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      };
      const activation = await ctx.subagents.startActivation({
        provider: config.provider,
        childId,
        label: `${definition.name}: ${args.description}`,
        request,
        signal: exec.signal,
        delivery: "parent",
      });
      for (const note of notes) ctx.logger.info(`${name}: ${note}`);
      return { kind: "activation", subagentId: activation.childId };
    } finally {
      pending.delete(childId);
    }
  };

  ctx.on("agent/created", ({ agent }) => {
    const header = agent?.session?.header;
    if (!header || installed.has(agent)) return;
    installed.add(agent);
    if (header.origin === "subagent") {
      const fresh = pending.get(agent.id);
      let record = fresh;
      if (fresh) {
        try {
          appendPluginRecord(agent.session, RECORD_TYPE, fresh);
        } catch (error) {
          // Only a resume after a restart needs it; this child runs either way.
          ctx.logger.warn(`${name}: could not record ${fresh.name}'s definition in ${agent.id}: ${error.message}`);
        }
      } else {
        record = recordedDefinition(agent.session);
      }
      if (record) applyToChild(agent, record);
      return;
    }
    // A top-level session: offer its definitions on its `subagent` tool.
    const base = ctx.tools.get(config.toolName);
    if (!base) return;
    const cwd = header.cwd ?? process.cwd();
    const { agents, warnings } = loadAgentDefinitions({ ...loadOptions, cwd });
    for (const warning of warnings) ctx.logger.warn(`${name}: ${warning}`);
    if (agents.size === 0) return;
    ctx.logger.info(`${name}: session ${agent.id}: ${agents.size} agent definition(s): ${[...agents.keys()].join(", ")}`);
    agent.ctx.tools.register(withAgentParameter(base, agents, (args, exec) => spawnDefined(args, exec, cwd)));
  });
}

/**
 * The child's route for `definition.model`: undefined to inherit the parent's.
 * `provider/model` names both; a bare id is a model of the parent's provider.
 * A Claude alias or a model the provider does not list falls back to the
 * parent's route (with a note) rather than failing the delegation.
 */
export async function resolveModel(ctx, parent, definition, signal, notes = []) {
  const wanted = definition.model;
  if (!wanted) return undefined;
  if (CLAUDE_MODEL_ALIASES.has(wanted.toLowerCase())) {
    notes.push(`${definition.name}: model "${wanted}" is a Claude alias; using the parent's model`);
    return undefined;
  }
  const parentOptions = parentAgentOptionsForDelegation(parent);
  const llm = ctx.get("llm");
  let provider = parentOptions.provider;
  let model = wanted;
  const slash = wanted.indexOf("/");
  if (slash > 0 && llm?.listProviders?.().some((entry) => entry.id === wanted.slice(0, slash))) {
    provider = wanted.slice(0, slash);
    model = wanted.slice(slash + 1);
  }
  if (provider === parentOptions.provider && model === parentOptions.model) return undefined;
  try {
    const listed = llm ? await llm.listModels(provider) : [];
    if (listed.length > 0 && !listed.some((entry) => entry.id === model)) {
      notes.push(`${definition.name}: model "${wanted}" is not offered by ${provider}; using the parent's model`);
      return undefined;
    }
    await llm?.resolveCallConfig({ provider, model }, signal);
  } catch (error) {
    notes.push(`${definition.name}: model "${wanted}" is unavailable (${error.message}); using the parent's model`);
    return undefined;
  }
  return { provider, model };
}
