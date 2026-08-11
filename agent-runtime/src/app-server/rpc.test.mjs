import { test } from "node:test";
import assert from "node:assert/strict";
import { createDispatcher, isRequest, isNotification, isResponse, RpcError, RPC } from "./rpc.mjs";

test("requests, notifications and responses are told apart by id and method", () => {
  assert.ok(isRequest({ method: "a", id: 1 }));
  assert.ok(isNotification({ method: "a" }));
  assert.ok(isNotification({ method: "a", id: null }));
  assert.ok(isResponse({ id: 1, result: {} }));
  assert.ok(!isRequest({ id: 1, result: {} }));
});

test("a request gets its handler's value back under the same id", async () => {
  const dispatch = createDispatcher({ handlers: { "thread/start": async (p) => ({ cwd: p.cwd }) } });
  assert.deepEqual(await dispatch({ method: "thread/start", id: 9, params: { cwd: "/x" } }), { id: 9, result: { cwd: "/x" } });
});

test("a notification produces no reply", async () => {
  let seen = 0;
  const dispatch = createDispatcher({ handlers: { "turn/steer": async () => { seen++; } } });
  assert.equal(await dispatch({ method: "turn/steer", params: {} }), null);
  assert.equal(seen, 1);
});

test("an unknown method is METHOD_NOT_FOUND when nothing forwards it", async () => {
  const dispatch = createDispatcher({ handlers: {} });
  const reply = await dispatch({ method: "fs/readFile", id: 3 });
  assert.equal(reply.error.code, RPC.METHOD_NOT_FOUND);
  assert.match(reply.error.message, /fs\/readFile/);
});

test("the fallback takes every method the handlers do not claim", async () => {
  // This is the seam the hybrid server uses: engine methods handled here,
  // platform methods forwarded to the Rust app-server.
  const forwarded = [];
  const dispatch = createDispatcher({
    handlers: { "turn/start": async () => ({ mine: true }) },
    fallback: async (method, params) => { forwarded.push(method); return { forwarded: true }; },
  });
  assert.deepEqual((await dispatch({ method: "turn/start", id: 1 })).result, { mine: true });
  assert.deepEqual((await dispatch({ method: "fs/readFile", id: 2 })).result, { forwarded: true });
  assert.deepEqual(forwarded, ["fs/readFile"]);
});

test("a handler that throws answers with an error instead of taking the session down", async () => {
  const errors = [];
  const dispatch = createDispatcher({
    handlers: { boom: async () => { throw new Error("engine exploded"); } },
    onError: (e, m) => errors.push([m, e.message]),
  });
  const reply = await dispatch({ method: "boom", id: 4 });
  assert.equal(reply.error.code, RPC.INTERNAL_ERROR);
  assert.match(reply.error.message, /engine exploded/);
  assert.deepEqual(errors, [["boom", "engine exploded"]]);
});

test("RpcError carries a specific code through", async () => {
  const dispatch = createDispatcher({ handlers: { bad: async () => { throw new RpcError(RPC.INVALID_PARAMS, "cwd is required"); } } });
  const reply = await dispatch({ method: "bad", id: 5 });
  assert.equal(reply.error.code, RPC.INVALID_PARAMS);
});

test("a failing notification still produces no reply", async () => {
  const dispatch = createDispatcher({ handlers: { n: async () => { throw new Error("x"); } } });
  assert.equal(await dispatch({ method: "n" }), null);
});

test("a response from the client is not routed as a request", async () => {
  // Approvals travel server->client, so the client's answer comes back as a
  // response; the caller correlates it, the dispatcher must ignore it.
  const dispatch = createDispatcher({ handlers: {} });
  assert.equal(await dispatch({ id: 1, result: { decision: "approved" } }), null);
});
