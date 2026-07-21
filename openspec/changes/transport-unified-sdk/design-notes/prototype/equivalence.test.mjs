// prototype/equivalence.test.mjs
//
// Proves the thesis: the SAME client surface, run EMBEDDED (in-memory router)
// vs REMOTE (over a real HTTP listener), produces equivalent results, errors,
// and event streams. "Embedded vs remote = transport swap, not a second
// protocol." Run: `node --test equivalence.test.mjs`.
//
// This is the prototype of tasks 4.2 / 6.1 (contract equivalence tests).

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRouter } from "./router.mjs";
import { createClient, createEmbeddedClient } from "./client.mjs";
import { createDemoBackend } from "./demo-backend.mjs";

/** Boot the SAME assembled router behind a real socket (the remote transport). */
async function startRemote(backend) {
  const handler = createRouter(backend);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = `http://127.0.0.1${req.url}`;
    const webReq = new Request(url, { method: req.method, headers: req.headers, body, duplex: "half" });
    const webRes = await handler(webReq);
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
    if (webRes.body) {
      const reader = webRes.body.getReader();
      while (true) { const { value, done } = await reader.read(); if (done) break; res.write(value); }
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function drain(iter) { const out = []; for await (const e of iter) out.push(e); return out; }

test("embedded and remote produce equivalent results across the surface", async () => {
  const embeddedBackend = createDemoBackend("js-agent-core");
  const remoteBackend = createDemoBackend("js-agent-core");

  const embedded = createEmbeddedClient(embeddedBackend);
  const remote = startRemote ? await startRemote(remoteBackend) : null;
  const network = createClient({ baseUrl: remote.baseUrl });

  try {
    // health + capabilities
    assert.deepEqual((await embedded.health()).backend, (await network.health()).backend);
    assert.deepEqual(await embedded.capabilities(), await network.capabilities());

    // create + prompt + history parity
    const e1 = await embedded.sessions.create({ title: "t" });
    const n1 = await network.sessions.create({ title: "t" });

    const eAdm = await embedded.sessions.prompt(e1.id, { text: "hi", id: "msg_x" });
    const nAdm = await network.sessions.prompt(n1.id, { text: "hi", id: "msg_x" });
    assert.equal(eAdm.delivery, nAdm.delivery);
    assert.equal(eAdm.delivered, nAdm.delivered);

    const eHist = await embedded.sessions.history(e1.id);
    const nHist = await network.sessions.history(n1.id);
    assert.deepEqual(eHist.map((x) => x.event), nHist.map((x) => x.event));

    // SSE replay parity
    const eEvents = await drain(embedded.sessions.events(e1.id));
    const nEvents = await drain(network.sessions.events(n1.id));
    assert.deepEqual(eEvents.map((x) => x.event), nEvents.map((x) => x.event));

    // error semantics parity (unknown session -> 404 not_found)
    const eErr = await embedded.sessions.get("ses_missing").catch((x) => x);
    const nErr = await network.sessions.get("ses_missing").catch((x) => x);
    assert.equal(eErr.status, nErr.status);
    assert.equal(eErr.code, nErr.code);
  } finally {
    await remote.close();
  }
});

test("capability gap is expressed uniformly, not by forking the client", async () => {
  // A backend lacking `revert` returns 501 unsupported through the SAME client call.
  const rust = createEmbeddedClient(createDemoBackend("rust-app-server"));
  const caps = await rust.capabilities();
  assert.equal(caps["revert.stage_commit_clear"], false);
  const s = await rust.sessions.create({});
  const err = await rust.sessions.revert.stage(s.id, { messageID: "msg_1" }).catch((x) => x);
  assert.equal(err.status, 501);
  assert.equal(err.code, "unsupported");
});
