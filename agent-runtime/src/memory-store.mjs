/**
 * memory-store.mjs — filesystem storage for agent-core's Tier-1 core memory.
 *
 * agent-core owns the SEMANTICS of core memory (memory-core.mjs: char-capped
 * buckets, threat scanning) and deliberately owns none of the persistence: the
 * `memory` tool asks its consumer for a `writeCoreMemory` function. Studio backs
 * that with a database row and a rev-CAS update; UnieAI Code has no database, so
 * this module backs it with one JSON file per model under UNIEAI_HOME, keeping
 * the same read-modify-write contract:
 *
 *     write({ customModelId, mutate }) -> { written: boolean, core }
 *
 * `mutate` receives a private copy of the current core and returns it to commit
 * or null to abort (a rejected memory action must not touch the file). It may be
 * re-run, because a concurrent commit forces a fresh read and a retry.
 *
 * Reads never throw. A missing file is the normal first-run case and a corrupt
 * one is indistinguishable from it at the call site; degrading to empty state
 * costs the user their remembered facts, whereas throwing would take down the
 * turn that happened to touch memory.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { unieaiHome } from "./config.mjs";
import { createFileMutationQueue } from "./file-mutation-queue.mjs";

const DIR_NAME = "core-memory";

/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 10_000;

/** How long a writer waits for the lock before reporting a conflict upward. */
const LOCK_WAIT_MS = 5_000;

/** Retries when the revision check finds someone else committed first. */
const MAX_COMMIT_ATTEMPTS = 5;

/**
 * In-process serialization of writes to the same file.
 *
 * createFileMutationQueue() is exactly the right tool for half of this problem:
 * it keys on the CANONICAL path, so every in-process writer of one model's
 * memory file lines up behind the same queue, and read-modify-write is what it
 * was built to serialize. Two departures from how tools.mjs uses it:
 *
 *   · It is module-scoped here, not per-instance. tools.mjs keeps a queue per
 *     request so requests never share locks; for memory the contended resource
 *     is the FILE, and a per-instance queue would let the foreground turn and
 *     the background review agent — separate storage instances, same file —
 *     interleave their reads and lose a write. Different files still get
 *     different queues, so nothing unrelated is serialized.
 *   · It is not sufficient on its own. The queue only knows about this process,
 *     and a second `unieai` session on the same machine writes the same file.
 *     Hence the on-disk lock plus the revision compare-and-set below; the queue
 *     stays because it turns the common (in-process) case into a cheap await
 *     instead of a lock-file spin.
 */
const writeQueue = createFileMutationQueue();

/** Directory holding one file per model. Not created until something is written. */
export function coreMemoryDir() {
  return join(unieaiHome(), DIR_NAME);
}

/**
 * Where one model's core memory lives.
 *
 * The id is sanitized for the filesystem AND suffixed with a digest of the
 * original: model slugs differ by exactly the characters sanitizing strips
 * (`vendor/model:v2` vs `vendor-model-v2`), and two models sharing one memory
 * file would silently cross-contaminate what each remembers.
 */
export function coreMemoryPath(customModelId, dir = null) {
  const id = String(customModelId ?? "").trim();
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60) || "default";
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return join(dir ?? coreMemoryDir(), `${safe}-${digest}.json`);
}

/** The shape memory-core.mjs and review.mjs expect to mutate. */
export function emptyCore() {
  return {
    rev: 0,
    memory: { entries: [] },
    user: { entries: [] },
    counters: { userTurnsAtReview: 0, toolItersSinceSkillReview: 0 },
  };
}

/**
 * Coerce whatever was on disk into a core that applyMemoryAction can operate on.
 *
 * The strictness is deliberate: applyMemoryAction calls `e.text.includes(...)`
 * and indexes `core[target].entries`, so a half-written or hand-edited file
 * would throw from inside agent-core rather than here. Dropping malformed
 * entries loses at most the damaged ones; unknown top-level keys are carried
 * through so a future agent-core field is not erased by an older build.
 */
function normalizeCore(raw) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rev = Number.isFinite(Number(base.rev)) && Number(base.rev) >= 0 ? Math.floor(Number(base.rev)) : 0;
  const counters = base.counters && typeof base.counters === "object" ? base.counters : {};
  return {
    ...base,
    rev,
    memory: { entries: normalizeEntries(base.memory) },
    user: { entries: normalizeEntries(base.user) },
    counters: {
      userTurnsAtReview: Number(counters.userTurnsAtReview) || 0,
      toolItersSinceSkillReview: Number(counters.toolItersSinceSkillReview) || 0,
    },
  };
}

function normalizeEntries(bucket) {
  const entries = Array.isArray(bucket?.entries) ? bucket.entries : [];
  const out = [];
  for (const entry of entries) {
    const text = typeof entry?.text === "string" ? entry.text : "";
    if (!text) continue;
    out.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : createHash("sha256").update(text).digest("hex").slice(0, 32),
      text,
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
    });
  }
  return out;
}

/** Read the core stored at an exact path, tolerating absence and corruption. */
async function readAt(path) {
  try {
    return normalizeCore(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return emptyCore();
  }
}

/**
 * Read one model's core memory. The engine renders this once at request entry
 * (agent-core's frozen-snapshot rule) and never re-reads mid-turn.
 */
export async function readCoreMemory(customModelId, { dir = null } = {}) {
  return readAt(coreMemoryPath(customModelId, dir));
}

/**
 * Synchronous read, for callers that assemble a system prompt without awaiting.
 *
 * `createEngine` is synchronous and builds the prompt inline, so the async read
 * cannot be used there. Sharing `normalizeCore` keeps the two paths from
 * drifting: a difference in how they repair a damaged file would show up as
 * memory that reads back differently depending on who asked.
 */
export function readCoreMemorySync(customModelId, { dir = null } = {}) {
  try {
    return normalizeCore(JSON.parse(readFileSync(coreMemoryPath(customModelId, dir), "utf8")));
  } catch {
    return emptyCore();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take an exclusive on-disk lock, or report failure.
 *
 * `open(..., "wx")` is atomic across processes, which a "check then create"
 * pair is not. A crashed holder would otherwise wedge memory forever, so a lock
 * whose mtime is older than LOCK_STALE_MS is taken over. Stale takeover is the
 * one case that can put two writers inside the critical section at once — which
 * is precisely what the revision compare-and-set below still catches.
 */
async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8").catch(() => {});
      await handle.close();
      return true;
    } catch (err) {
      // Anything other than "already held" (an unwritable home, say) is not
      // going to fix itself by waiting.
      if (err?.code !== "EEXIST") return false;
      try {
        const held = await stat(lockPath);
        if (Date.now() - held.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // holder released it between the failed open and the stat
      }
      if (Date.now() >= deadline) return false;
      await sleep(10);
    }
  }
}

/** Replace the file in one step, so a reader never sees a half-written core. */
async function commit(path, core) {
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(temp, `${JSON.stringify(core, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

/**
 * Build a `writeCoreMemory` function for agent-core's memory tool and review
 * agent.
 *
 * @param {object} [options]
 * @param {string|null} [options.dir]   override the storage directory (tests)
 * @param {object|null} [options.queue] override the in-process queue; passing a
 *   fresh queue makes two instances behave like two processes, which is how the
 *   cross-process guard is tested
 */
export function createCoreMemoryStorage({ dir = null, queue = null } = {}) {
  const serializer = queue ?? writeQueue;

  return async function writeCoreMemory({ customModelId, mutate } = {}) {
    const path = coreMemoryPath(customModelId, dir);
    if (typeof mutate !== "function") return { written: false, core: await readAt(path) };

    return serializer.run(path, async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
      } catch {
        // An unwritable home is reported as a conflict, not thrown: the tool
        // tells the model "continue without saving" and the turn survives.
        return { written: false, core: emptyCore() };
      }

      const lockPath = `${path}.lock`;
      if (!(await acquireLock(lockPath))) {
        return { written: false, core: await readAt(path) };
      }

      try {
        for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
          const before = await readAt(path);
          const draft = await mutate(structuredClone(before));
          if (!draft) return { written: false, core: before };

          // Compare-and-set on the revision counter. The read above and the
          // write below are not one atomic step, and `mutate` may await in
          // between; if anyone committed in that window their revision moved,
          // and writing our draft would silently drop their entry. Re-read and
          // let mutate run again against the winner's state instead.
          const current = await readAt(path);
          if (current.rev !== before.rev) continue;

          const next = normalizeCore({ ...draft, rev: before.rev + 1 });
          await commit(path, next);
          return { written: true, core: next };
        }
        // Persistently contended. Reporting written:false makes the tool tell
        // the model to try again rather than pretend the memory was saved.
        return { written: false, core: await readAt(path) };
      } catch {
        return { written: false, core: await readAt(path) };
      } finally {
        await rm(lockPath, { force: true }).catch(() => {});
      }
    });
  };
}

let defaultStorage = null;

/**
 * The process-wide storage function to inject as agent-core's `writeCoreMemory`
 * (directly, or via configureCoreMemoryStorage). Memoized so every caller and
 * the background review agent share one instance — and therefore one queue.
 */
export function coreMemoryWriter() {
  if (!defaultStorage) defaultStorage = createCoreMemoryStorage();
  return defaultStorage;
}
