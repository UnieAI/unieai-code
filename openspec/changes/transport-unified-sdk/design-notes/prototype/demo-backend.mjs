// prototype/demo-backend.mjs
//
// A trivial in-memory backend implementing the operation interface the router
// dispatches to. It stands in for BOTH real backends:
//   - the JS agent-core adapter (wraps agent-runtime/src/engine.mjs)
//   - the Rust app-server adapter (translates ops <-> JSON-RPC, or Rust hosts
//     the router natively over hyper)
// The point of the prototype is that the router + client + codecs are identical
// regardless of which backend sits behind this interface.

export function createDemoBackend(name = "js-agent-core") {
  const sessions = new Map();
  const seqs = new Map();
  const listeners = new Map();

  const emit = (id, evt) => {
    const s = (seqs.get(id) || 0) + 1;
    seqs.set(id, s);
    const withSeq = { ...evt, seq: s };
    (sessions.get(id)?.log || []).push(withSeq);
    for (const l of listeners.get(id) || []) l(withSeq);
  };

  return {
    name,
    capabilities: () => ({
      steer: name === "js-agent-core",
      queue: name === "js-agent-core",
      "revert.stage_commit_clear": name === "js-agent-core",
      question: true,
      compact: true,
      web_access: name === "js-agent-core",
      checkpoints: name === "js-agent-core",
      share: false,
    }),
    getConfig: async () => ({ models: [{ id: "default" }], activeModel: "default", sandbox: "workspace-write", approvalPolicy: "on-request", signedIn: true }),
    listSessions: async () => [...sessions.values()].map((s) => ({ id: s.id, title: s.title })),
    createSession: async (input) => {
      const id = "ses_" + Math.random().toString(36).slice(2, 8);
      sessions.set(id, { id, title: input?.title || "untitled", cwd: input?.cwd, model: input?.model || "default", log: [] });
      return { id, title: sessions.get(id).title };
    },
    getSession: async (id) => { must(sessions, id); return { id, ...sessions.get(id) }; },
    history: async (id, { after }) => { must(sessions, id); const log = sessions.get(id).log; return after == null ? log : log.filter((e) => e.seq > after); },
    prompt: async (id, input) => {
      must(sessions, id);
      const delivery = input.delivery || "default";
      const delivered = delivery === "default" || name === "js-agent-core";
      emit(id, { event: "turn.state", state: "running" });
      emit(id, { event: "message.delta", itemKey: "m1", text: `echo: ${input.text}` });
      emit(id, { event: "turn.state", state: "idle", retryable: false });
      return { id: input.id || "msg_" + Date.now(), sessionID: id, delivery, delivered };
    },
    interrupt: async (id) => { must(sessions, id); emit(id, { event: "turn.state", state: "interrupted" }); },
    compact: async (id) => { must(sessions, id); emit(id, { event: "context.compacted", freedChars: 0 }); },
    setWebAccess: async (id, value) => { must(sessions, id); sessions.get(id).webAccess = !!value; },
    revertStage: async (id, input) => {
      must(sessions, id);
      if (name !== "js-agent-core") throw unsupported("revert not supported on this backend");
      return { messageID: input.messageID, snapshot: "tree_demo", diff: "", files: [] };
    },
    revertClear: async (id) => { must(sessions, id); },
    revertCommit: async (id) => { must(sessions, id); },
    permissionReply: async (id, reqId, input) => { must(sessions, id); emit(id, { event: "permission.request", requestID: reqId, resolved: input.reply }); },
    questionReply: async (id, reqId) => { must(sessions, id); emit(id, { event: "question.request", requestID: reqId, resolved: true }); },
    questionReject: async (id, reqId) => { must(sessions, id); },
    async *events(id, { after }) {
      must(sessions, id);
      const log = sessions.get(id).log;
      for (const e of (after == null ? log : log.filter((e) => e.seq > after))) yield e;
    },
  };
}

function must(map, id) { if (!map.has(id)) { const e = new Error(`session ${id} not found`); e.code = "not_found"; throw e; } }
function unsupported(msg) { const e = new Error(msg); e.code = "unsupported"; return e; }
