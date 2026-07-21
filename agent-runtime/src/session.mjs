/**
 * session.mjs — minimal session persistence for the agent-core runtime.
 *
 * One JSON file per session under $UNIEAI_HOME/agent-sessions/. Stores the
 * chat-completions message history (agent-core's native shape) plus metadata,
 * so any surface (TUI, VS Code panel) can list and resume conversations.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { unieaiHome } from "./config.mjs";

function sessionsDir() {
  const dir = join(unieaiHome(), "agent-sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
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
  const path = join(sessionsDir(), `${id}.json`);
  writeFileSync(
    path,
    JSON.stringify({ id, model, cwd, updatedAt: Date.now(), summary, contextEpoch, checkpoints, plan, messages }, null, 0)
  );
  return path;
}

export function loadSession(id) {
  const raw = readFileSync(join(sessionsDir(), `${String(id).replace(/[^\w.-]/g, "")}.json`), "utf8");
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
      const firstUser = (parsed.messages || []).find((m) => m.role === "user");
      rows.push({
        id: parsed.id || name.replace(/\.json$/, ""),
        preview: String(firstUser?.content || "(empty)").slice(0, 120),
        cwd: parsed.cwd || "",
        model: parsed.model || "",
        mtime
      });
    } catch {
      /* skip corrupt file */
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit);
}
