// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-thread-store.mjs — the app-server threads an engine has served, on disk.
 *
 * The Rust app-server keeps its own thread index; threads served from here
 * are not in it, so `thread/list` and `thread/resume` answered by Rust never
 * saw them. An engine whose conversations persist (uac: dsh sessions) keeps
 * this index so they can be listed, resumed, forked and reverted.
 *
 * One JSON document, rewritten atomically. Small by nature: one entry per
 * thread with ids and titles, never conversation content.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FIELDS = [
  "id",
  "cwd",
  "model",
  "modelProvider",
  "preview",
  "name",
  "archived",
  "forkedFromId",
  "createdAtEpoch",
  "updatedAtEpoch",
  "turnIds",
  "engineState",
  // The client's tools (thread/start `dynamicTools`); thread/resume does not
  // resend them, as with the Rust server, which keeps them with the thread.
  "clientTools",
];

export function createThreadStore(path) {
  let cache = null;

  const load = () => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      cache = new Map(Object.entries(parsed?.threads ?? {}));
    } catch {
      cache = new Map();
    }
    return cache;
  };

  const flush = () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, threads: Object.fromEntries(load()) }, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  };

  return {
    get(id) {
      const entry = load().get(id);
      return entry ? { ...entry, turnIds: [...(entry.turnIds ?? [])] } : null;
    },
    /** Persist the durable fields of a live thread object. */
    save(thread) {
      const entry = {};
      for (const field of FIELDS) {
        if (thread[field] !== undefined) entry[field] = thread[field];
      }
      load().set(thread.id, entry);
      flush();
    },
    delete(id) {
      if (load().delete(id)) flush();
    },
    list() {
      return [...load().values()];
    },
  };
}
