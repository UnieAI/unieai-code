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
 * thread with ids and titles, never conversation content beyond the short
 * text of a turn the engine answered without a model turn (`turnMeta`).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FIELDS = [
  "id",
  "cwd",
  "model",
  "effort",
  "modelProvider",
  "preview",
  "name",
  "archived",
  "forkedFromId",
  "createdAtEpoch",
  "updatedAtEpoch",
  "turnIds",
  // What each turn began with in the engine (unieai-turn-anchors.mjs): dsh
  // turn numbers, and the few words shown for a turn the engine never saw.
  "turnMeta",
  "engineState",
  // The client's tools (thread/start `dynamicTools`); thread/resume does not
  // resend them, as with the Rust server, which keeps them with the thread.
  "clientTools",
  // The engine variant it runs in (uac: the dsh mode); a resumed thread stays in it.
  "mode",
  // The client's -s / -a for the thread ({ sandbox, approval }).
  "permissions",
];

export function createThreadStore(path) {
  let cache = null;

  const read = () => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return new Map(Object.entries(parsed?.threads ?? {}));
    } catch {
      return new Map();
    }
  };

  const load = () => {
    cache ??= read();
    return cache;
  };

  // Two servers can share the file: one of another release still serving its
  // clients while the new one serves the rest (unieai-launch's drain). Writing
  // this process's whole cache would drop the threads the other one added, so
  // each write lays this change over what is on disk now.
  const flush = (id, entry) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const threads = read();
    if (entry) threads.set(id, entry);
    else threads.delete(id);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, threads: Object.fromEntries(threads) }, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    for (const [key, value] of threads) if (!cache.has(key)) cache.set(key, value);
  };

  return {
    get(id) {
      const entry = load().get(id);
      return entry ? { ...entry, turnIds: [...(entry.turnIds ?? [])], turnMeta: { ...(entry.turnMeta ?? {}) } } : null;
    },
    /** Persist the durable fields of a live thread object. */
    save(thread) {
      const entry = {};
      for (const field of FIELDS) {
        if (thread[field] !== undefined) entry[field] = thread[field];
      }
      load().set(thread.id, entry);
      flush(thread.id, entry);
    },
    delete(id) {
      if (load().delete(id)) flush(id, null);
    },
    list() {
      return [...load().values()];
    },
  };
}
