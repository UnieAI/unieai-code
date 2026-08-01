/**
 * session.mjs — minimal session persistence for the agent-core runtime.
 *
 * One JSON file per session under $UNIEAI_HOME/agent-sessions/. Stores the
 * chat-completions message history (agent-core's native shape) plus metadata,
 * so any surface (TUI, VS Code panel) can list and resume conversations.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { unieaiHome } from "./config.mjs";

function sessionsDir() {
  const dir = join(unieaiHome(), "agent-sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Reduce an id to something that cannot escape the sessions directory.
 *
 * Shared by save and load because they previously disagreed: load sanitized and
 * save did not, so an id containing `../` would have been WRITTEN outside the
 * directory and then not found on the way back. Ids come from `newSessionId()`
 * today, but the asymmetry stops being theoretical the moment one arrives from
 * a UI or a `--resume` flag.
 */
function safeId(id) {
  return String(id ?? "").replace(/[^\w.-]/g, "");
}

/** The shadow-git dir for a session's workspace checkpoints (see snapshot.mjs). */
export function snapshotDir(sessionId) {
  return join(unieaiHome(), "agent-snapshots", `${String(sessionId).replace(/[^\w.-]/g, "")}.git`);
}

export function newSessionId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export function saveSession({ id, messages, model, cwd, summary = "", contextEpoch = null, checkpoints = null, plan = null }) {
  const dir = sessionsDir();
  const path = join(dir, `${safeId(id)}.json`);
  const body = JSON.stringify({ id, model, cwd, updatedAt: Date.now(), summary, contextEpoch, checkpoints, plan, messages }, null, 0);

  // Write beside the target, then rename over it. Writing in place meant a crash
  // or a full disk mid-write truncated the ONLY copy of the conversation; with
  // this, the existing file stays intact until the replacement is complete.
  //
  // The temp file must share the directory: rename is atomic only within one
  // filesystem, and a temp elsewhere would silently degrade to copy-then-delete,
  // reintroducing the window this exists to close. No fsync — that would buy
  // durability against power loss at the cost of a disk flush every turn, and
  // losing the last turn to a power cut is far cheaper than that.
  const tmp = join(dir, `.${safeId(id)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* the temp may never have been created */ }
    throw error;
  }
  return path;
}

export function loadSession(id) {
  const raw = readFileSync(join(sessionsDir(), `${safeId(id)}.json`), "utf8");
  return JSON.parse(raw);
}

export function listSessions(limit = 30) {
  const dir = sessionsDir();
  const rows = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const path = join(dir, name);
      const mtime = statSync(path).mtimeMs;
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      // Skip synthetic wrappers (project instructions, context updates, folded
      // summaries) so the preview shows the user's actual first message, not
      // the same AGENTS.md snippet on every row.
      const firstUser = (parsed.messages || []).find(
        (m) => m.role === "user" && !/^\s*<(project_instructions|context_update|conversation_summary)\b/.test(String(m.content || ""))
      );
      rows.push({
        id: parsed.id || name.replace(/\.json$/, ""),
        preview: String(firstUser?.content || "(empty)").slice(0, 120),
        cwd: parsed.cwd || "",
        model: parsed.model || "",
        mtime
      });
    } catch {
      // Surface the damage instead of hiding it. Skipping made a corrupt
      // session vanish from the picker with no sign it had ever existed, so the
      // user could not tell "I never had that conversation" from "that
      // conversation is unreadable" — and the file it points at is still there
      // to be recovered by hand.
      let mtime = 0;
      try { mtime = statSync(join(dir, name)).mtimeMs; } catch { /* gone mid-scan */ }
      rows.push({
        id: name.replace(/\.json$/, ""),
        preview: "(unreadable — this session file is damaged)",
        cwd: "",
        model: "",
        mtime,
        corrupt: true
      });
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit);
}
