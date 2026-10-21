// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * The reference relay's test page: pair from a link, pick a session, follow
 * its transcript, send messages, approve or deny, answer questions. Ava builds
 * the real UI; this is for end-to-end testing and on-prem fallback.
 */
import { createRemoteClient, parsePairingLink } from "/lib/unieai-remote-client.mjs";

const STORE_KEY = "unieai-remote-hosts";
const $ = (id) => document.getElementById(id);

const storage = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    } catch {
      return {};
    }
  },
  write(hosts) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(hosts));
    } catch {}
  },
};

function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : "Linux";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${os} · ${browser}`;
}

// --- Which host ---------------------------------------------------------------

let host = null;
let psk = null;
let device = null;
if (location.hash.includes("v=1")) {
  try {
    const link = parsePairingLink(location.href);
    psk = link.psk;
    host = { relayUrl: link.relayUrl, roomId: link.roomId, joinToken: link.joinToken, hostKey: link.hostKey, hostName: link.hostName };
  } catch (error) {
    $("intro").textContent = error.message;
  }
  // The secret must not stay in the address bar or history (§4.1).
  history.replaceState(null, "", location.pathname);
}
const hosts = storage.read();
if (!host) {
  const last = Object.values(hosts).sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0))[0];
  if (last) ({ host, device } = last);
} else if (hosts[host.roomId]?.device) {
  device = hosts[host.roomId].device;
}

// --- Rendering ----------------------------------------------------------------

const items = new Map(); // item id -> element
const asks = new Map(); // request id -> { element, turnId }
let current = null; // thread id
let activeTurn = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function itemText(item) {
  switch (item.type) {
    case "userMessage":
      return (item.content ?? []).map((part) => part.text ?? "").join("\n");
    case "agentMessage":
      return item.text ?? "";
    case "commandExecution":
      return `$ ${item.command ?? ""}${item.aggregatedOutput ? `\n${item.aggregatedOutput}` : ""}${item.exitCode != null ? `\n(exit ${item.exitCode})` : ""}`;
    case "fileChange":
      return (item.changes ?? []).map((change) => `${change.kind?.type ?? change.kind ?? "edit"} ${change.path}`).join("\n");
    case "contextCompaction":
      return "context compacted";
    default:
      return item.text ?? "";
  }
}

function renderItem(item) {
  if (item.type === "reasoning") return;
  let node = items.get(item.id);
  const kind = item.type === "userMessage" ? "user" : item.type === "agentMessage" ? "agent" : "tool";
  if (!node) {
    node = el("div", { class: `item ${kind}` }, el("span", { class: "label" }, item.type === "userMessage" ? "You" : item.type === "agentMessage" ? "Assistant" : item.type), el("span"));
    items.set(item.id, node);
    $("transcript").append(node);
  }
  const text = itemText(item);
  if (text || item.type !== "agentMessage") node.lastChild.textContent = text;
  node.scrollIntoView({ block: "end" });
}

function appendDelta(itemId, delta) {
  const node = items.get(itemId);
  if (node) node.lastChild.textContent += delta;
}

function showThreads(list) {
  current = null;
  $("threads").replaceChildren(
    ...list.map((thread) =>
      el("button", { onclick: () => openThread(thread.id) }, thread.name || thread.preview || thread.id, el("small", {}, new Date(thread.updatedAt * 1000).toLocaleString())),
    ),
  );
  if (!list.length) $("threads").replaceChildren(el("div", { class: "notice" }, "No sessions yet."));
  $("threads").hidden = false;
  $("transcript").hidden = true;
  $("composer").hidden = true;
  $("back").hidden = true;
  $("stop").hidden = true;
  $("title").textContent = host?.hostName || "UnieAI Remote";
}

function askCard(id, method, params, resolve) {
  const finish = (result) => {
    asks.get(id)?.element.remove();
    asks.delete(id);
    resolve(result);
  };
  let body;
  if (method === "item/tool/requestUserInput") {
    const answers = {};
    body = el("div");
    for (const question of params.questions ?? []) {
      const other = el("input", { type: "text", placeholder: "Other…" });
      const choices = (question.options ?? []).map((option) =>
        el("button", { class: "act", type: "button", onclick: () => (answers[question.id] = { answers: [option.label] }) }, option.label),
      );
      other.addEventListener("input", () => (answers[question.id] = { answers: [`user_note: ${other.value}`] }));
      body.append(el("p", {}, question.question), el("div", { class: "actions" }, ...choices), other);
    }
    body.append(el("div", { class: "actions" }, el("button", { class: "act ok", type: "button", onclick: () => finish({ answers }) }, "Answer")));
  } else {
    const what = method === "item/fileChange/requestApproval" ? "Apply file changes?" : `Run ${params.command ?? "a command"}?`;
    body = el(
      "div",
      {},
      el("p", {}, what),
      params.reason ? el("small", {}, params.reason) : "",
      el(
        "div",
        { class: "actions" },
        el("button", { class: "act ok", type: "button", onclick: () => finish({ decision: "accept" }) }, "Approve"),
        el("button", { class: "act", type: "button", onclick: () => finish({ decision: "acceptForSession" }) }, "Approve for session"),
        el("button", { class: "act bad", type: "button", onclick: () => finish({ decision: "decline" }) }, "Deny"),
      ),
    );
  }
  const element = el("div", { class: "item ask" }, el("span", { class: "label" }, "Needs your answer"), body);
  asks.set(id, { element, turnId: params.turnId, cancel: () => resolve(method === "item/tool/requestUserInput" ? { answers: {} } : { decision: "cancel" }) });
  $("transcript").append(element);
  element.scrollIntoView({ block: "end" });
}

// --- The session ----------------------------------------------------------------

const client = host
  ? createRemoteClient({
      host,
      psk,
      device,
      deviceName: deviceName(),
      onPaired: (paired) => {
        device = paired;
        hosts[host.roomId] = { host, device, usedAt: Date.now() };
        storage.write(hosts);
      },
      onState: (state, detail) => {
        $("state").textContent = state === "ready" ? "connected" : state;
        if (state === "error" && detail === "unknown_device") {
          delete hosts[host.roomId];
          storage.write(hosts);
          $("intro").textContent = "This browser is no longer paired. Run /remote-control again for a new link.";
          $("intro").hidden = false;
        }
        if (state === "reset" && current) setTimeout(() => openThread(current), 200);
      },
      onNotification: (method, params) => {
        if (params.threadId && params.threadId !== current) return;
        if (method === "item/started" || method === "item/completed") renderItem(params.item);
        else if (method === "item/agentMessage/delta") appendDelta(params.itemId, params.delta);
        else if (method === "turn/started") {
          activeTurn = params.turn?.id ?? params.turnId;
          $("stop").hidden = false;
        } else if (method === "turn/completed") {
          activeTurn = null;
          $("stop").hidden = true;
          for (const [id, ask] of asks) {
            if (ask.turnId === params.turn?.id) {
              ask.element.remove();
              asks.delete(id);
            }
          }
        } else if (method === "serverRequest/resolved") {
          // Answered somewhere else (the TUI, another browser).
          asks.get(params.requestId)?.element.remove();
          asks.delete(params.requestId);
        }
      },
      onRequest: (method, params, id) => new Promise((resolve) => askCard(id, method, params, resolve)),
    })
  : null;

async function openThread(threadId) {
  current = threadId;
  items.clear();
  $("transcript").replaceChildren();
  const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
  for (const turn of thread.turns ?? []) for (const item of turn.items ?? []) renderItem(item);
  activeTurn = thread.status?.type === "active" ? (thread.turns?.at(-1)?.id ?? null) : null;
  $("title").textContent = thread.name || thread.preview || "Session";
  $("threads").hidden = true;
  $("transcript").hidden = false;
  $("composer").hidden = false;
  $("back").hidden = false;
  $("stop").hidden = !activeTurn;
}

$("back").addEventListener("click", async () => {
  if (current) await client.request("thread/unsubscribe", { threadId: current }).catch(() => {});
  showThreads((await client.request("thread/list", { limit: 50 })).data);
});
$("stop").addEventListener("click", () => current && client.request("turn/interrupt", { threadId: current }));
$("send").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("input").value.trim();
  if (!text || !current) return;
  $("input").value = "";
  const input = [{ type: "text", text }];
  try {
    if (activeTurn) await client.request("turn/steer", { threadId: current, input });
    else await client.request("turn/start", { threadId: current, input });
  } catch (error) {
    $("transcript").append(el("div", { class: "item" }, `Not sent: ${error.message}`));
  }
});

if (client) {
  $("intro").hidden = true;
  try {
    await client.connect();
    await client.request("initialize");
    showThreads((await client.request("thread/list", { limit: 50 })).data);
  } catch (error) {
    $("intro").hidden = false;
    $("intro").textContent = `Could not connect: ${error.message}`;
  }
}
