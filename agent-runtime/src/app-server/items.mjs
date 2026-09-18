// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * items.mjs — turn agent-runtime's tool events into the protocol's items.
 *
 * The TUI renders `item/started` / `item/completed` notifications, each carrying
 * an item whose `type` decides which card is drawn. Our engine emits its own
 * event vocabulary (tool_use_started, file_diff, file_read, …), so something has
 * to translate, and the mapping has to match what the Rust server sends or the
 * client silently renders nothing.
 *
 * Shapes here were taken from a live `unieai app-server` session rather than from
 * the generated TypeScript: the types mark much as optional that the TUI in fact
 * reads, and a missing field shows up as an empty pane rather than an error.
 */
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";

/**
 * Protocol item types we produce, by tool.
 *
 * Matched to the vocabulary the Rust engine actually uses — `commandExecution`
 * for anything that inspects or runs, `fileChange` for edits — because the TUI's
 * rendering is built around those two. Mapping reads and searches to the
 * semantically-truer `fileRead`/`search` produced far plainer output than the
 * same session under codex, which is the whole reason to be here.
 */
const TOOL_ITEM_TYPE = {
  bash: "commandExecution",
  run_tests: "commandExecution",
  run_background: "commandExecution",
  read: "commandExecution",
  grep: "commandExecution",
  glob: "commandExecution",
  write: "fileChange",
  edit: "fileChange",
};

/**
 * A readable one-line rendering of what a tool call does.
 *
 * These are shown where codex shows the shell line it ran. We do NOT run a
 * subprocess for reads and searches, so the string describes the operation in
 * the shell idiom that performs it rather than claiming a particular command
 * executed — `cat foo.py` for a whole-file read, the `sed` range form for a
 * windowed one.
 */
export function commandLabel(tool, args = {}) {
  switch (tool) {
    case "bash":
    case "run_background":
      return String(args.cmd || args.command || args.__raw || "");
    case "run_tests":
      return `run tests${args.target || args.__raw ? ` ${args.target || args.__raw}` : ""}${args.keyword ? ` -k ${args.keyword}` : ""}`;
    case "read": {
      const path = String(args.filePath || args.__raw || "");
      const from = Number(args.offset) || 0;
      const count = Number(args.limit) || 0;
      if (from || count) return `sed -n '${from || 1},${count ? (from || 1) + count - 1 : "$"}p' ${path}`;
      return `cat ${path}`;
    }
    case "grep":
      return `rg ${JSON.stringify(String(args.pattern || args.__raw || ""))}${args.path ? ` ${args.path}` : ""}`;
    case "glob":
      return `rg --files -g ${JSON.stringify(String(args.pattern || args.__raw || ""))}`;
    default:
      return tool;
  }
}

/**
 * What a read or search did, in the protocol's CommandAction shape. These are
 * facts from the call's arguments, not a parse of a shell line, and with them
 * the TUI draws codex's compact "Explored" cell (Read calc.py, Search foo)
 * instead of dumping the tool's raw output under a pretend `cat`.
 */
export function commandActions(tool, args = {}, cwd = null) {
  const command = commandLabel(tool, args);
  const under = (p) => (!p ? null : isAbsolute(p) || !cwd ? p : join(cwd, p));
  switch (tool) {
    case "read": {
      const path = String(args.filePath || args.__raw || "");
      if (!path) return [];
      return [{ type: "read", command, name: basename(path), path: under(path) }];
    }
    case "grep":
      return [{ type: "search", command, query: String(args.pattern || args.__raw || "") || null, path: args.path ? String(args.path) : null }];
    case "glob":
      return [{ type: "search", command, query: String(args.pattern || args.__raw || "") || null, path: args.path ? String(args.path) : null }];
    default:
      return [];
  }
}

/** A protocol item id. The client correlates started/completed by it. */
export const newItemId = () => randomUUID();

/**
 * Build the item for a tool call starting.
 *
 * A tool we have no mapping for is NOT emitted as a generic card. The protocol's
 * item union has 18 members and `toolCall` is not one of them, so the client —
 * which drops anything it cannot deserialize, silently, by design
 * (app-server-client/src/remote.rs) — would discard it. A card that renders
 * nothing is indistinguishable from an engine that did nothing, so an unmapped
 * tool is reported as the closest thing that is true: a command execution
 * labelled with the tool's name.
 */
export function startedItem({ tool, args = {}, id = newItemId(), cwd = null, change = null }) {
  const type = TOOL_ITEM_TYPE[tool] || "commandExecution";
  const base = { type, id, status: "inProgress" };
  if (type === "fileChange") {
    // The TUI draws the diff card from the STARTED item. An engine that knows
    // the change before running it (dsh: from the call's arguments) passes it
    // here; agent-runtime only learns it after the write, so its card is empty.
    return { ...base, changes: change?.diff ? [fileUpdateChange(change)] : [] };
  }
  return {
    ...base,
    command: commandLabel(tool, args),
    cwd: cwd ?? process.cwd(),
    // We do not run these through a PTY. Shell lines are not pre-parsed —
    // that would put guesses in front of the user as facts — but reads and
    // searches say exactly what they did.
    processId: null,
    source: "agent",
    commandActions: commandActions(tool, args, cwd),
    aggregatedOutput: "",
    exitCode: null,
    durationMs: null,
  };
}

/** Build the item for a tool call finishing. `ok` false marks it failed. */
export function completedItem({ tool, id, ok = true, output = "", extra = {}, cwd = null }) {
  const type = TOOL_ITEM_TYPE[tool] || "commandExecution";
  const base = { type, id, status: ok ? "completed" : "failed" };
  if (type === "fileChange") {
    return { ...base, changes: extra.diff ? [fileUpdateChange(extra)] : [] };
  }
  return {
    ...base,
    command: extra.command ?? commandLabel(tool, extra.args ?? {}),
    cwd: cwd ?? process.cwd(),
    processId: null,
    source: "agent",
    commandActions: commandActions(tool, extra.args ?? {}, cwd),
    aggregatedOutput: String(output).slice(0, 20_000),
    exitCode: extra.exitCode ?? (ok ? 0 : 1),
    durationMs: extra.durationMs ?? null,
  };
}

/**
 * One protocol FileUpdateChange. For `add` and `delete` the `diff` field holds
 * the file's content, for `update` a unified diff — the TUI reads it that way.
 */
function fileUpdateChange({ path, kind, diff }) {
  return { path: path ?? "", kind: patchChangeKind(kind), diff };
}

/**
 * The engine says "add" / "update" / "delete"; the protocol wants a tagged
 * union, and `update` carries the path a move sent the file to.
 */
export function patchChangeKind(kind, movePath = null) {
  if (kind === "add") return { type: "add" };
  if (kind === "delete") return { type: "delete" };
  return { type: "update", movePath: movePath ?? null };
}

/**
 * The assistant's own message, streamed as deltas then completed.
 *
 * Note the asymmetry with `userMessageItem`: a user message carries a `content`
 * array of parts, an agent message carries a plain `text` string. Reusing the
 * user shape here left the client with nothing to display.
 */
export const agentMessageItem = (id, text) => ({
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
});

/**
 * The model's reasoning, streamed as deltas then completed.
 *
 * An `item/reasoning/textDelta` names an item that must already have been
 * opened, and carries a `contentIndex`. Sending deltas with neither — as this
 * bridge did — leaves the client with a stream of text belonging to nothing,
 * which it drops.
 */
export const reasoningItem = (id, content = "") => ({
  type: "reasoning",
  id,
  summary: [],
  content: content ? [content] : [],
});

/** Echo of what the user asked — the Rust server emits this before working. */
export const userMessageItem = (id, text) => ({
  type: "userMessage",
  id,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});

/**
 * Translate an engine event stream into protocol notifications.
 *
 * Returns `onToolEvent(event)`; each call emits zero or more notifications
 * through `emit(method, params)`. Item ids are kept per tool_use_id so a
 * completion lands on the card its start created.
 */
export function createItemBridge(emit) {
  const open = new Map(); // tool_use_id -> { itemId, tool, args }
  return function onToolEvent(event) {
    const useId = event?.tool_use_id || event?.id;
    const tool = event?.tool_name || event?.tool || "";
    switch (event?.type) {
      case "tool_use_started": {
        const itemId = newItemId();
        const args = parseArgs(event.args_preview ?? event.args);
        open.set(useId, { itemId, tool, args });
        const change = event.diff ? { path: event.path, kind: event.kind, diff: event.diff } : null;
        // The lifecycle timestamps are required: a notification without them
        // does not deserialize, and the client drops it without a word.
        emit("item/started", { item: startedItem({ tool, args, id: itemId, change }), startedAtMs: Date.now() });
        break;
      }
      // A tool that reports a timeline event (read -> file_read, grep -> grep,
      // edit/write -> file_diff) has ITS event emitted INSTEAD of the generic
      // completion, so treating only `tool_use_completed` as the end left those
      // cards spinning forever in the client.
      case "file_read":
      case "file_diff":
      case "grep":
      case "glob":
      case "tool_use_completed":
      case "tool_use_failed": {
        const entry = open.get(useId) || { itemId: newItemId(), tool, args: {} };
        open.delete(useId);
        emit("item/completed", {
          item: completedItem({
            tool: entry.tool || tool,
            id: entry.itemId,
            // Only the explicit failure event means failure; a timeline event
            // (file_read, grep, …) IS the success report for that tool.
            ok: event.type !== "tool_use_failed",
            output: event.output_preview || event.error || "",
            extra: {
              command: commandLabel(entry.tool || tool, entry.args),
              args: entry.args,
              path: event.path ?? entry.args.filePath ?? entry.args.__raw,
              query: entry.args.pattern,
              diff: event.diff,
              kind: event.kind,
              matches: event.matches,
              ...(Number.isInteger(event.exit_code) ? { exitCode: event.exit_code } : {}),
            },
          }),
          completedAtMs: Date.now(),
        });
        break;
      }
      default:
        break; // engine-internal events (doom_warning, completion_nudge, …) have no card
    }
  };
}

/**
 * Recover the tool's arguments from the loop's preview.
 *
 * `previewArgs` collapses a call with a single string argument to that bare
 * string — so a read of "calc.py" arrives as `calc.py`, not as JSON. Keeping the
 * raw value lets the label fall back to it instead of rendering `cat ` with
 * nothing after it.
 */
function parseArgs(preview) {
  if (!preview) return {};
  if (typeof preview === "object") return preview;
  const text = String(preview);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : { __raw: text };
  } catch {
    return { __raw: text };
  }
}
