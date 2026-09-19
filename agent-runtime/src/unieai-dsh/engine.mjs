// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * engine.mjs — unieai-agent-core (uac): one conversation on deepseek-harness.
 *
 * Presents the engine shape the app-server bridge drives
 * (`send` / `steer` / `compact` / `messages`) and implements it as one ACP
 * session on a shared dsh process. dsh reports text, thoughts and a generic
 * tool lifecycle; this file turns those into agent-runtime's engine events so
 * items.mjs and approval.mjs work unchanged.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { AcpError } from "./acp-client.mjs";
import { DSH_PROVIDER_ID } from "./config.mjs";
import { completedItem, reasoningItem, agentMessageItem, userMessageItem } from "../app-server/items.mjs";

/** dsh tool names -> the vocabulary items.mjs maps to protocol items. */
const TOOL_NAMES = {
  bash: "bash",
  bash_persistent: "bash",
  pwsh: "bash",
  // unieai-exec (codex-style unified exec)
  exec_command: "bash",
  write_stdin: "bash",
  read: "read",
  read_image: "read",
  grep: "grep",
  glob: "glob",
  edit: "edit",
  str_replace_editor: "edit",
  write: "write",
  apply_patch: "edit",
};

/**
 * What a terminal card shows for an exec_command / write_stdin result. The
 * tool's text is written for the model (chunk id, wall time, token count,
 * then `Output:`); the user sees the command's output and its exit code, as
 * codex's own cards do.
 */
export function terminalView(dshName, text) {
  if (dshName !== "exec_command" && dshName !== "write_stdin") return null;
  const raw = String(text ?? "");
  const marker = raw.match(/^Output:\n?/m);
  if (!marker) return null;
  const header = raw.slice(0, marker.index);
  const exit = header.match(/Process exited with code (-?\d+)/);
  const running = header.match(/Process running with session ID (\d+)/);
  return {
    output: raw.slice(marker.index + marker[0].length),
    exitCode: exit ? Number(exit[1]) : null,
    running: Boolean(running),
  };
}

export function engineToolName(dshName) {
  return TOOL_NAMES[dshName] ?? dshName;
}

/** POSIX single-quoting. */
export function shellQuote(text) {
  return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

export function shellWrapped(script) {
  return `bash -lc ${shellQuote(script)}`;
}

/** dsh arguments -> the argument names items.mjs reads for its labels. */
export function engineToolArgs(dshName, rawInput) {
  if (!rawInput || typeof rawInput !== "object") {
    return rawInput == null ? {} : { __raw: String(rawInput) };
  }
  const args = { ...rawInput };
  const path = rawInput.file_path ?? rawInput.path;
  if (path !== undefined) args.filePath = path;
  // The TUI splits the command with shlex and unwraps `bash -lc <script>`, so
  // a bare script with `&&` would render as `'&&'`. Send it the way codex does.
  if (rawInput.command !== undefined) args.cmd = shellWrapped(String(rawInput.command));
  if (dshName === "exec_command" && rawInput.cmd !== undefined) args.cmd = shellWrapped(String(rawInput.cmd));
  if (dshName === "write_stdin") {
    const chars = String(rawInput.chars ?? "");
    const action = chars === "\u0003" ? "interrupt" : chars ? `send ${JSON.stringify(chars)}` : "poll";
    args.cmd = `${action} session ${rawInput.session_id}`;
  }
  if (dshName === "read" && rawInput.offset !== undefined) args.offset = rawInput.offset;
  return args;
}

const lineCount = (text) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);
const prefixed = (text, mark) =>
  text === "" ? [] : text.replace(/\n$/, "").split("\n").map((line) => `${mark}${line}`);

/**
 * The change an edit call makes, as the protocol's FileUpdateChange wants it:
 * the new content for an added file, a unified diff otherwise. dsh reports no
 * diff, so it is built from the call's own arguments; the hunk is positioned
 * at line 1 because the call does not say where in the file the text was.
 */
/**
 * The first file an apply_patch call changes, as a FileUpdateChange. Codex's
 * patch hunks carry no line numbers, so each gets a nominal header the diff
 * renderer accepts.
 */
export function diffFromApplyPatch(patch) {
  const lines = String(patch ?? "").split("\n");
  const start = lines.findIndex((line) => /^\*\*\* (Add|Update|Delete) File: /.test(line));
  if (start < 0) return null;
  const [, verb, path] = lines[start].match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("*** ")) {
      if (line.startsWith("*** Move to: ") || line.startsWith("*** End of File")) continue;
      break;
    }
    body.push(line);
  }
  if (verb === "Add") return { path, kind: "add", diff: `${body.map((line) => line.replace(/^\+/, "")).join("\n")}\n` };
  if (verb === "Delete") return { path, kind: "delete", diff: "" };
  const hunks = [];
  let hunk = null;
  for (const line of body) {
    if (line.startsWith("@@")) {
      hunk = [];
      hunks.push(hunk);
    } else {
      if (!hunk) {
        hunk = [];
        hunks.push(hunk);
      }
      hunk.push(line);
    }
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks.filter((h) => h.length)) {
    const before = h.filter((line) => !line.startsWith("+")).length;
    const after = h.filter((line) => !line.startsWith("-")).length;
    out.push(`@@ -1,${before} +1,${after} @@`, ...h.map((line) => (/^[ +-]/.test(line) ? line : ` ${line}`)));
  }
  return { path, kind: "update", diff: `${out.join("\n")}\n` };
}

export function diffFromArgs(dshName, args = {}) {
  if (dshName === "apply_patch") return diffFromApplyPatch(args.input ?? args.patch);
  const path = args.file_path ?? args.path;
  if (!path) return null;
  let before;
  let after;
  if (dshName === "write") {
    before = "";
    after = String(args.content ?? args.file_text ?? "");
  } else if (args.old_string !== undefined || args.new_string !== undefined) {
    before = String(args.old_string ?? "");
    after = String(args.new_string ?? "");
  } else if (args.old_str !== undefined || args.new_str !== undefined) {
    before = String(args.old_str ?? "");
    after = String(args.new_str ?? "");
  } else if (args.file_text !== undefined) {
    before = "";
    after = String(args.file_text);
  } else {
    return null;
  }
  const kind = dshName === "write" || args.command === "create" ? "add" : "update";
  if (kind === "add") return { path, kind, diff: after };
  const header = [
    `--- ${kind === "add" ? "/dev/null" : `a/${path}`}`,
    `+++ b/${path}`,
    `@@ -${lineCount(before) ? 1 : 0},${lineCount(before)} +1,${lineCount(after)} @@`,
  ];
  return { path, kind, diff: [...header, ...prefixed(before, "-"), ...prefixed(after, "+")].join("\n") + "\n" };
}

/** The text of an ACP content list (`tool_call_update.content`). */
export function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      const inner = entry?.type === "content" ? entry.content : entry;
      return inner?.type === "text" ? inner.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** `[provider, model]` from an ACP model option value. */
function parseModelValue(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The option value that selects `model` on our provider, if dsh offers it. */
export function findModelOption(configOptions = [], model) {
  const option = configOptions.find((entry) => entry?.id === "model");
  if (!option || !model) return null;
  const flat = (option.options ?? []).flatMap((entry) => (Array.isArray(entry?.options) ? entry.options : [entry]));
  const matches = flat
    .map((entry) => ({ value: entry?.value, parsed: parseModelValue(entry?.value) }))
    .filter(({ parsed }) => parsed?.[1] === model);
  return (matches.find(({ parsed }) => parsed[0] === DSH_PROVIDER_ID) ?? matches[0])?.value ?? null;
}

/**
 * The shared half: one dsh process serves every thread, and routes its
 * notifications and permission requests to the session they belong to.
 */
export function createDshHost({ connect, connectControl = null, onLog = () => {} }) {
  let agentPromise = null;
  let controlPromise = null;
  const sessions = new Map(); // sessionId -> { onUpdate, onPermission }

  const agent = () => {
    if (!agentPromise) {
      agentPromise = connect().then((acp) => {
        acp.onNotification("session/update", ({ sessionId, update }) => {
          sessions.get(sessionId)?.onUpdate(update);
        });
        acp.onRequest("session/request_permission", async (params) => {
          const session = sessions.get(params.sessionId);
          if (!session) return { outcome: { outcome: "cancelled" } };
          return session.onPermission(params);
        });
        acp.exited?.then(({ code, signal }) => {
          onLog(`dsh exited (code ${code}, signal ${signal}); the next turn restarts it`);
          agentPromise = null;
          controlPromise?.then((channel) => channel.close(), () => {});
          controlPromise = null;
        });
        return acp;
      });
      agentPromise.catch(() => {
        agentPromise = null;
      });
    }
    return agentPromise;
  };

  /** The unieai-control channel into the same dsh process (see unieai-control.mjs). */
  const control = async (method, params) => {
    if (!connectControl) throw new Error("this dsh host has no control channel");
    await agent();
    if (!controlPromise) {
      controlPromise = connectControl();
      controlPromise.catch(() => {
        controlPromise = null;
      });
    }
    const channel = await controlPromise;
    if (!channel.unieaiToolRoute) {
      // Client tools registered through this channel call back on it.
      channel.unieaiToolRoute = true;
      channel.onRequest?.("callTool", (call) => {
        const session = sessions.get(call?.sessionId);
        if (!session?.onToolCall) throw new Error(`no client tools for session ${call?.sessionId}`);
        return session.onToolCall(call);
      });
    }
    try {
      return await channel.request(method, params);
    } catch (error) {
      if (channel.closed) controlPromise = null;
      throw error;
    }
  };

  return {
    agent,
    control,
    register(sessionId, handlers) {
      sessions.set(sessionId, handlers);
    },
    unregister(sessionId) {
      sessions.delete(sessionId);
    },
    async close() {
      (await controlPromise?.catch(() => null))?.close();
      const acp = await agentPromise?.catch(() => null);
      acp?.kill?.();
    },
  };
}

const isRouteNotReady = (error) => /no adapter registered/.test(`${error?.message} ${JSON.stringify(error?.data ?? "")}`);

/**
 * `session/new`, waiting out dsh's startup: providers from settings.yaml
 * register a moment after `initialize` answers, and a session created before
 * then fails with "no adapter registered for provider".
 */
export async function newSessionWhenRoutesReady(acp, params, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await acp.request("session/new", params);
    } catch (error) {
      if (!isRouteNotReady(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

const TURN_STATUS = { interrupted: "interrupted", aborted: "interrupted", error: "failed", blocked: "failed" };

/** One unieai-control history turn -> the engine's HistoryTurn (see server.mjs). */
export function historyTurn(turn) {
  const items = [];
  for (const entry of turn.items ?? []) {
    switch (entry.type) {
      case "user":
        items.push(userMessageItem("", entry.text));
        break;
      case "assistant":
        items.push(agentMessageItem("", entry.text));
        break;
      case "reasoning":
        items.push(reasoningItem("", entry.text));
        break;
      case "tool": {
        let rawInput = entry.arguments;
        try {
          rawInput = JSON.parse(entry.arguments);
        } catch {
          // Malformed model output stays a raw string, as the live card shows it.
        }
        const edit = entry.status === "failed" ? null : diffFromArgs(entry.name, rawInput ?? {});
        const item = completedItem({
          tool: engineToolName(entry.name),
          id: "",
          ok: entry.status !== "failed",
          output: entry.output,
          extra: {
            args: engineToolArgs(entry.name, rawInput),
            ...(edit ? { path: edit.path, diff: edit.diff, kind: edit.kind } : {}),
          },
        });
        items.push(entry.status === "inProgress" ? { ...item, status: "inProgress" } : item);
        break;
      }
      default:
        break;
    }
  }
  return {
    items,
    status: turn.endSeq === null ? "inProgress" : TURN_STATUS[turn.reason] ?? "completed",
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
  };
}

/** Pick the allow/reject option ids from a permission request. */
function permissionOptionId(options = [], allow) {
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const found = options.find((option) => option?.kind === kind);
    if (found) return found.optionId;
  }
  return null;
}

/**
 * One conversation. `host` is shared across conversations; everything else is
 * the same contract agent-runtime's createEngine takes.
 */
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/**
 * A turn's ACP prompt: the text, then its images. A model that takes images
 * gets them inline (dsh advertises `promptCapabilities.image` only then). A
 * text-only model gets each image's path and is told to describe it with
 * describe_image (unieai-vision-fallback); inline images are written to a
 * temporary file for that.
 */
export async function promptContent(text, images = [], { imageInput = false, tmp = tmpdir() } = {}) {
  const content = [{ type: "text", text }];
  const notes = [];
  for (const image of images) {
    let data = null;
    let mimeType = null;
    let path = image.path ?? null;
    if (image.url?.startsWith("data:")) {
      const match = image.url.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
      if (match) {
        mimeType = match[1];
        data = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
      }
    } else if (path) {
      mimeType = IMAGE_TYPES[extname(path).toLowerCase()] ?? null;
      data = await readFile(path).catch(() => null);
    }
    if (!data) {
      notes.push(`[An attached image could not be read${path ? `: ${path}` : ""}.]`);
      continue;
    }
    if (imageInput && mimeType && Object.values(IMAGE_TYPES).includes(mimeType)) {
      content.push({ type: "image", mimeType, data: data.toString("base64") });
      continue;
    }
    if (!path) {
      const dir = join(tmp, "unieai-images");
      await mkdir(dir, { recursive: true });
      const ext = Object.entries(IMAGE_TYPES).find(([, type]) => type === mimeType)?.[0] ?? ".png";
      path = join(dir, `${randomUUID()}${ext}`);
      await writeFile(path, data);
    }
    notes.push(`[The user attached an image: ${path}. You cannot see images directly; look at it with describe_image.]`);
  }
  if (notes.length > 0) content[0] = { type: "text", text: `${text}\n\n${notes.join("\n")}` };
  return content;
}

export function createDshEngine({
  host,
  workspace,
  model = null,
  onText = () => {},
  onReasoning = () => {},
  onToolEvent = () => {},
  requestApproval = null,
  onLog = () => {},
  // `{ sessionId }` of a conversation to continue, and where to report it.
  resumeState = null,
  onState = () => {},
  // Tools the app-server client hosts (`dynamicTools` from thread/start), and
  // how to run one (the client answers `item/tool/call`).
  clientTools = () => null,
  callClientTool = null,
  // The client's sandbox and approval for this thread ({ sandbox, approval }
  // in dsh's terms), applied to the dsh session whenever it is opened.
  permissions = () => null,
  // Called with { total, last, modelContextWindow } as the session's token usage grows.
  onUsage = () => {},
}) {
  let sessionId = resumeState?.sessionId ?? null;
  let sessionAgent = null;
  let turnActive = false;
  const messages = [];
  const toolCalls = new Map(); // toolCallId -> { name, rawInput }
  const allowedForSession = new Set();
  let turnText = "";

  const onUpdate = (update) => {
    switch (update?.sessionUpdate) {
      case "agent_message_chunk": {
        const text = update.content?.type === "text" ? update.content.text : "";
        if (text) {
          turnText += text;
          onText(text);
        }
        break;
      }
      case "agent_thought_chunk": {
        const text = update.content?.type === "text" ? update.content.text : "";
        if (text) onReasoning(text);
        break;
      }
      case "tool_call": {
        const name = update.title || "tool";
        toolCalls.set(update.toolCallId, { name, rawInput: update.rawInput });
        const edit = diffFromArgs(name, update.rawInput ?? {});
        onToolEvent({
          type: "tool_use_started",
          tool_use_id: update.toolCallId,
          tool_name: engineToolName(name),
          args: engineToolArgs(name, update.rawInput),
          ...(edit ? { path: edit.path, diff: edit.diff, kind: edit.kind } : {}),
        });
        break;
      }
      case "tool_call_update": {
        if (update.status !== "completed" && update.status !== "failed") break;
        const call = toolCalls.get(update.toolCallId) ?? { name: update.title || "tool", rawInput: update.rawInput };
        toolCalls.delete(update.toolCallId);
        const output = contentText(update.content);
        const terminal = terminalView(call.name, output);
        // A command that ran and exited non-zero is a failed card, as in codex.
        const failed = update.status === "failed" || (terminal?.exitCode != null && terminal.exitCode !== 0);
        const edit = update.status === "failed" ? null : diffFromArgs(call.name, call.rawInput ?? {});
        const shown = terminal ? terminal.output : output;
        onToolEvent({
          type: failed ? "tool_use_failed" : edit ? "file_diff" : "tool_use_completed",
          tool_use_id: update.toolCallId,
          tool_name: engineToolName(call.name),
          output_preview: shown,
          error: failed ? shown : undefined,
          ...(terminal?.exitCode != null ? { exit_code: terminal.exitCode } : {}),
          ...(edit ? { path: edit.path, diff: edit.diff, kind: edit.kind } : {}),
        });
        break;
      }
      case "usage_update":
        // dsh committed a model call: refresh the token counts.
        reportUsage();
        break;
      default:
        break; // anything newer has no card
    }
  };

  const onPermission = async ({ toolCall, options }) => {
    const call = toolCalls.get(toolCall?.toolCallId) ?? { name: toolCall?.title || "tool", rawInput: toolCall?.rawInput };
    const tool = engineToolName(call.name);
    const input = call.rawInput && typeof call.rawInput === "object" ? call.rawInput : {};
    let allow;
    if (allowedForSession.has(tool)) {
      allow = true;
    } else if (!requestApproval) {
      allow = false;
    } else {
      const detail = input.command ?? input.file_path ?? input.path ?? JSON.stringify(call.rawInput ?? {});
      const decision = await requestApproval({ tool, action: call.name, detail, reason: null }).catch(() => "decline");
      if (decision === "acceptForSession") allowedForSession.add(tool);
      allow = decision === "accept" || decision === "acceptForSession";
    }
    const optionId = permissionOptionId(options, allow);
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  };

  const selectModel = async (acp, configOptions) => {
    if (!model) return;
    const value = findModelOption(configOptions, model);
    if (value) {
      await acp.request("session/set_config_option", { sessionId, configId: "model", value });
    } else {
      onLog(`dsh offers no model "${model}"; using its default`);
    }
  };

  const onToolCall = async (call) => {
    if (!callClientTool) throw new Error("this client hosts no tools");
    return callClientTool(call);
  };

  /** Offer the client's tools in `sessionId` (dsh forgets them when it restarts). */
  const registerClientTools = async () => {
    const tools = typeof clientTools === "function" ? clientTools() : clientTools;
    if (!Array.isArray(tools) || tools.length === 0 || !callClientTool) return;
    try {
      const { registered } = await host.control("registerTools", { sessionId, tools });
      onLog(`offered ${registered} client tool(s) to dsh session ${sessionId}`);
    } catch (error) {
      onLog(`could not offer client tools to dsh: ${error.message}`);
    }
  };

  /** Read the session's token usage from dsh and hand it to the client. */
  let usageInFlight = null;
  const reportUsage = () => {
    if (!sessionId || usageInFlight) return usageInFlight;
    usageInFlight = host
      .control("usage", { sessionId })
      .then((usage) => onUsage(usage))
      .catch((error) => onLog(`could not read token usage: ${error.message}`))
      .finally(() => {
        usageInFlight = null;
      });
    return usageInFlight;
  };

  /** Apply the thread's `-s` / `-a` to the open session. */
  const applyPermissions = async () => {
    const wanted = typeof permissions === "function" ? permissions() : permissions;
    if (!wanted || (!wanted.sandbox && !wanted.approval)) return;
    try {
      const { applied } = await host.control("setPermissions", { sessionId, ...wanted });
      if (Object.keys(applied ?? {}).length > 0) onLog(`dsh session ${sessionId}: ${JSON.stringify(applied)}`);
    } catch (error) {
      onLog(`could not apply sandbox/approval to dsh: ${error.message}`);
    }
  };

  /** Open `sessionId` on the current dsh process, or start a new session. */
  const ensureSession = async () => {
    const acp = await host.agent();
    if (sessionId && sessionAgent === acp) return acp;
    if (sessionId) {
      // A stored conversation, or dsh restarted underneath us: sessions are
      // persisted, so resume.
      host.unregister(sessionId);
      try {
        const resumed = await acp.request("session/resume", { sessionId, cwd: workspace, mcpServers: [] });
        host.register(sessionId, { onUpdate, onPermission, onToolCall });
        sessionAgent = acp;
        await selectModel(acp, resumed?.configOptions);
        await registerClientTools();
        await applyPermissions();
        return acp;
      } catch (error) {
        onLog(`dsh could not resume ${sessionId} (${error.message}); starting a new session`);
      }
    }
    const created = await newSessionWhenRoutesReady(acp, { cwd: workspace, mcpServers: [] });
    sessionId = created.sessionId;
    sessionAgent = acp;
    host.register(sessionId, { onUpdate, onPermission, onToolCall });
    onState({ sessionId });
    await selectModel(acp, created.configOptions);
    await registerClientTools();
    await applyPermissions();
    return acp;
  };

  /** Stop serving the open session on dsh, keeping it persisted. */
  const closeSession = async () => {
    if (!sessionId || !sessionAgent) return;
    const acp = sessionAgent;
    host.unregister(sessionId);
    sessionAgent = null;
    await acp.request("session/close", { sessionId }).catch(() => {});
  };

  return {
    get messages() {
      return messages;
    },
    get sessionId() {
      return sessionId;
    },

    async send(text, { abortSignal, images = [] } = {}) {
      const acp = await ensureSession();
      const prompt = await promptContent(text, images, { imageInput: Boolean(acp.agentCapabilities?.promptCapabilities?.image) });
      messages.push({ role: "user", content: text });
      turnText = "";
      turnActive = true;
      const cancel = () => acp.notify("session/cancel", { sessionId });
      abortSignal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await acp.request("session/prompt", { sessionId, prompt });
        if (result?.stopReason === "refusal") {
          throw new AcpError("the model refused this request");
        }
        await usageInFlight;
        await reportUsage();
        return result;
      } finally {
        turnActive = false;
        abortSignal?.removeEventListener("abort", cancel);
        if (turnText) messages.push({ role: "assistant", content: turnText });
      }
    },

    /** Mid-turn input, delivered through dsh's own steering queue. */
    async steer(text) {
      if (!turnActive || !sessionId) return false;
      const { delivered } = await host.control("steer", { sessionId, text });
      if (delivered) messages.push({ role: "user", content: text });
      return Boolean(delivered);
    },

    async compact() {
      await ensureSession();
      const { compacted } = await host.control("compact", { sessionId });
      return Boolean(compacted);
    },

    /** The conversation's user turns, as protocol items, from dsh's log. */
    async history() {
      if (!sessionId) return [];
      const { turns } = await host.control("history", { sessionId });
      return turns.map(historyTurn);
    },

    /** A new conversation holding the first `keepTurns` turns (all when null). */
    async fork({ keepTurns = null } = {}) {
      if (!sessionId) return { state: null, keptTurns: 0 };
      const { sessionId: child, keptTurns } = await host.control("fork", { sessionId, keepTurns });
      return { state: { sessionId: child }, keptTurns };
    },

    /** Drop every turn after the first `keepTurns`, continuing on a trimmed copy. */
    async revert({ keepTurns }) {
      if (!sessionId) return;
      if (turnActive) throw new Error("cannot revert while a turn is running");
      await closeSession();
      const { sessionId: child } = await host.control("fork", { sessionId, keepTurns });
      sessionId = child;
      onState({ sessionId });
      messages.length = 0;
    },

    async close() {
      await closeSession();
    },
  };
}
