/**
 * file-mutation-queue.mjs — serialize mutations that touch the same file.
 *
 * The loop runs a step's tool calls with bounded concurrency, so two `edit`
 * calls on one file can be in flight at once. Today the content-hash staleness
 * guard catches that — it sees the file changed since the model read it and
 * refuses — so nothing is corrupted, but one perfectly valid edit fails and the
 * model has to re-read and retry for no reason. Serializing per file lets both
 * apply, in order.
 *
 * Keys are CANONICAL paths: `./src/a.ts`, `src/a.ts`, and a symlink pointing at
 * it are one file and must share one queue. Keying on the string the model
 * happened to type would hand them separate queues and serialize nothing.
 *
 * The queue map is per-instance rather than module-scope, so concurrent
 * requests never share locks (Invariant #1).
 *
 * Translated from pi's file-mutation-queue idea; implementation is our own.
 */

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolve a path to something stable enough to lock on.
 *
 * A file being CREATED does not exist yet, so its own realpath fails; we
 * canonicalize the nearest existing ancestor instead and re-attach the rest.
 * Without that, two creates of the same not-yet-existing file would take
 * different keys — exactly the case where a race is most likely.
 */
export function canonicalKey(path) {
  const absolute = resolve(String(path ?? ""));
  try {
    return realpathSync(absolute);
  } catch {
    let parent = dirname(absolute);
    const rest = [absolute.slice(parent.length)];
    // Walk up until something resolves, or we run out of parents.
    for (let depth = 0; depth < 64; depth += 1) {
      try {
        return realpathSync(parent) + rest.join("");
      } catch {
        const next = dirname(parent);
        if (next === parent) break;
        rest.unshift(parent.slice(next.length));
        parent = next;
      }
    }
    return absolute;
  }
}

/**
 * A set of per-file queues.
 *
 * `run(path, fn)` waits for any in-flight work on that file, runs `fn`, and
 * hands the turn to whoever queued next.
 */
export function createFileMutationQueue() {
  /** canonical path → promise for the tail of that file's queue. */
  const tails = new Map();

  return {
    async run(path, fn) {
      const key = canonicalKey(path);
      const previous = tails.get(key) ?? Promise.resolve();

      // Chain onto the tail, swallowing the PREDECESSOR's rejection only: one
      // edit failing must not cancel the next in line, but this call's own
      // result still propagates to its caller.
      let release;
      const mine = new Promise((r) => { release = r; });
      // Compare against the CHAINED promise later, since that is what lands in
      // the map — checking `mine` would never match and the entry would leak.
      const chained = previous.then(() => mine, () => mine);
      tails.set(key, chained);

      await previous.catch(() => {});
      try {
        return await fn();
      } finally {
        release();
        // Drop the entry once this call is the last one queued, so the map does
        // not grow for the life of a long session.
        if (tails.get(key) === chained) tails.delete(key);
      }
    },

    /** Number of files with work queued — for tests and diagnostics. */
    get size() {
      return tails.size;
    },
  };
}
