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

/** Protocol item types we can produce, by the tool that produced them. */
const TOOL_ITEM_TYPE = {
  bash: "commandExecution",
  run_tests: "commandExecution",
  run_background: "commandExecution",
  read: "fileRead",
  write: "fileChange",
  edit: "fileChange",
  grep: "search",
  glob: "search",
};

/** A protocol item id. The client correlates started/completed by it. */
export const newItemId = () => randomUUID();

/**
 * Build the item for a tool call starting.
 * `args` is the model's argument object; unknown tools become a generic
 * `toolCall` rather than being dropped, so a new tool still shows up.
 */
export function startedItem({ tool, args = {}, id = newItemId() }) {
  const type = TOOL_ITEM_TYPE[tool] || "toolCall";
  const base = { type, id, status: "inProgress" };
  switch (type) {
    case "commandExecution":
      return { ...base, command: String(args.cmd || args.command || args.target || tool), aggregatedOutput: "", exitCode: null };
    case "fileRead":
      return { ...base, path: String(args.filePath || "") };
    case "fileChange":
      // The TUI shows a diff card; the patch arrives on completion, since the
      // engine only knows the result after the write lands.
      return { ...base, path: String(args.filePath || ""), changes: [] };
    case "search":
      return { ...base, query: String(args.pattern || args.query || "") };
    default:
      return { ...base, name: tool, arguments: safeJson(args) };
  }
}

/** Build the item for a tool call finishing. `ok` false marks it failed. */
export function completedItem({ tool, id, ok = true, output = "", extra = {} }) {
  const type = TOOL_ITEM_TYPE[tool] || "toolCall";
  const base = { type, id, status: ok ? "completed" : "failed" };
  switch (type) {
    case "commandExecution":
      return { ...base, command: extra.command ?? "", aggregatedOutput: String(output).slice(0, 20_000), exitCode: extra.exitCode ?? (ok ? 0 : 1) };
    case "fileRead":
      return { ...base, path: extra.path ?? "" };
    case "fileChange":
      return { ...base, path: extra.path ?? "", changes: extra.diff ? [{ path: extra.path ?? "", diff: extra.diff }] : [] };
    case "search":
      return { ...base, query: extra.query ?? "", matches: extra.matches ?? null };
    default:
      return { ...base, name: tool, output: String(output).slice(0, 20_000) };
  }
}

/** The assistant's own message, streamed as deltas then completed. */
export const agentMessageItem = (id, text) => ({ type: "agentMessage", id, content: [{ type: "text", text }] });

/** Echo of what the user asked — the Rust server emits this before working. */
export const userMessageItem = (id, text) => ({
  type: "userMessage",
  id,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});

function safeJson(value) {
  try { return JSON.stringify(value ?? {}); } catch { return "{}"; }
}

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
        emit("item/started", { item: startedItem({ tool, args, id: itemId }) });
        break;
      }
      case "tool_use_completed":
      case "tool_use_failed": {
        const entry = open.get(useId) || { itemId: newItemId(), tool, args: {} };
        open.delete(useId);
        emit("item/completed", {
          item: completedItem({
            tool: entry.tool || tool,
            id: entry.itemId,
            ok: event.type === "tool_use_completed",
            output: event.output_preview || event.error || "",
            extra: { command: entry.args.cmd || entry.args.command, path: entry.args.filePath, query: entry.args.pattern },
          }),
        });
        break;
      }
      case "file_diff": {
        // Emitted by edit/write alongside the tool events; carries the diff the
        // TUI's change card wants.
        const entry = [...open.values()].find((e) => e.tool === "edit" || e.tool === "write");
        if (entry) entry.diff = event.diff;
        break;
      }
      default:
        break; // engine-internal events (doom_warning, completion_nudge, …) have no card
    }
  };
}

function parseArgs(preview) {
  if (!preview) return {};
  if (typeof preview === "object") return preview;
  try { return JSON.parse(preview); } catch { return { cmd: String(preview) }; }
}
