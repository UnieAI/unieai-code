/**
 * turn-coordinator.mjs — serialize turns per session so concurrent sends never
 * interleave (idea from opencode's run-coordinator). The engine mutates one
 * shared `messages` array per conversation; two overlapping send() calls would
 * corrupt it. This chains work per key so a second send waits for the first,
 * and a coalesced "next" can be queued while one is running.
 *
 * Pure and dependency-free; the engine wraps its send() body in `run()`.
 */

/**
 * What is running matters, not just whether something is: a mid-turn
 * interjection belongs to a REGULAR turn and must not be folded into a
 * compaction or a review, which are not conversations and have nothing to do
 * with it. (codex draws the same line — `steer_input` rejects anything that is
 * not a Regular task.)
 */
export const TASK_KINDS = ["regular", "compact", "review"];

/**
 * @returns {{
 *   run: (key: string, thunk: () => Promise<any>, opts?: {kind?: string}) => Promise<any>,
 *   queueNext: (key: string, thunk: () => Promise<any>) => void,
 *   isBusy: (key: string) => boolean,
 *   activeKind: (key: string) => string|null,
 * }}
 */
export function createTurnCoordinator() {
  // key -> tail promise of the serial chain (undefined when idle).
  const chains = new Map();
  // key -> single coalesced follow-up thunk to drain after the active run.
  const nexts = new Map();
  // key -> kind of the run currently executing (not merely chained).
  const kinds = new Map();

  function chain(key, thunk, kind = "regular") {
    const prev = chains.get(key) || Promise.resolve();
    // The caller awaits `result` (real value/rejection). The chain tail swallows
    // rejections so one failed turn can't wedge the queue, and self-cleans when
    // it is still the tail (idle) so the maps don't grow unbounded.
    // The kind is recorded when this run actually STARTS, not when it is
    // chained: until then the previous run is still the one in flight, and it is
    // that one an interjection would be folded into.
    const start = () => { kinds.set(key, kind); return thunk(); };
    const result = prev.then(
      start,
      start, // run regardless of the previous turn's outcome
    );
    const tail = result.then(afterDrain, afterDrain);
    chains.set(key, tail);
    return result;

    // Runs after this turn settles. Only the CURRENT tail acts — if a newer run
    // was chained after us, let ITS afterDrain handle the follow-up. When idle,
    // drain one coalesced follow-up (on a FRESH chain: chaining it onto our own
    // still-resolving tail would deadlock), else forget the key.
    function afterDrain() {
      if (chains.get(key) !== tail) return;
      const next = nexts.get(key);
      chains.delete(key);
      kinds.delete(key);
      if (next) {
        nexts.delete(key);
        return chain(key, next);
      }
    }
  }

  return {
    run(key, thunk, { kind = "regular" } = {}) {
      return chain(key, thunk, kind);
    },
    /** Register ONE coalesced follow-up; a later call replaces an undrained one. */
    queueNext(key, thunk) {
      nexts.set(key, thunk);
    },
    isBusy(key) {
      return chains.has(key);
    },
    /** The kind currently executing, or null when idle or not yet started. */
    activeKind(key) {
      return kinds.get(key) ?? null;
    },
  };
}
