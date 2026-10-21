// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-remote-relay.mjs — a reference Remote Control relay.
 *
 * Implements the relay side of docs/unieai/remote-control-protocol.md (§2,
 * §3, §4.3, §7.1, §11) in one small Node HTTP server, plus the static test
 * page in ./public. It exists so the feature can be tested end to end and run
 * on-prem before Ava hosts the real one; Ava builds its own relay and UI from
 * the spec. State is in memory: a restart drops rooms and sessions, which
 * hosts and browsers recover from by registering and joining again.
 *
 * The relay never decrypts anything. It authenticates the host, admits
 * browsers that hold the room's join token, and forwards frames: `onFrame`
 * lets a test capture exactly what passed through it.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const LIB_DIR = join(HERE, "..", "app-server");
const NODE_MODULES = join(HERE, "..", "..", "node_modules");
/** The protocol modules the page shares with the host. */
const LIB_FILES = new Set(["unieai-remote-noise.mjs", "unieai-remote-channel.mjs", "unieai-remote-client.mjs"]);

const PREFIX = "/api/remote";
const HOST_SESSION_MS = 12 * 60 * 60 * 1000;
const CLIENT_SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_CLIENTS = 16;
const MAX_FRAME_CHARS = 96 * 1024;
const MAX_FRAMES = 64;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const HANDSHAKES_PER_MINUTE = 10;
/** Frame types a relay forwards end to end without reading (§7.1). */
const E2E_TYPES = new Set(["hs1", "hs2", "err", "d", "a", "reset"]);

const token = (prefix = "") => `${prefix}${randomBytes(16).toString("base64url")}`;
const sha = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Host validation (§3.1): ask the origin the credential belongs to who it
 * is. `allowedOrigins` is the relay's own list; an origin not on it is
 * refused, or any server could vouch for any token.
 */
export function upstreamValidator({ allowedOrigins, fetch: fetchImpl = globalThis.fetch }) {
  const allowed = new Set(allowedOrigins.map((origin) => origin.replace(/\/+$/, "")));
  const cache = new Map(); // sha(token) -> { owner, until }
  return async ({ account, origin, token: credential }) => {
    const base = String(origin ?? "").replace(/\/+$/, "");
    if (!allowed.has(base)) return null;
    const key = sha(`${account}\n${base}\n${credential}`);
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.owner;
    const path = account === "rabi" ? "/api/desktop/me" : "/api/user";
    const response = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${credential}` } }).catch(() => null);
    if (!response?.ok) return null;
    const body = await response.json().catch(() => null);
    const user = account === "rabi" ? body?.user : body;
    const id = user?.id ?? user?.email;
    if (!id) return null;
    const owner = account === "rabi" ? `rabi:${id}` : `studio:${base}:${id}`;
    cache.set(key, { owner, until: Date.now() + 5 * 60 * 1000 });
    return owner;
  };
}

/** For tests and local trials only: any non-empty token is its own owner. */
export const stubValidator = async ({ token: credential }) => (credential ? `stub:${sha(credential).slice(0, 16)}` : null);

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

/**
 * Start the relay. `publicUrl` is the origin browsers reach it at (the page
 * is served at `${publicUrl}/`). Answers `{ url, relayUrl, close, rooms }`.
 */
export async function startRemoteRelay({
  port = 0,
  host = "127.0.0.1",
  publicUrl = null,
  validateHost = stubValidator,
  onFrame = () => {},
  log = () => {},
  pingMs = 15_000,
} = {}) {
  const rooms = new Map(); // roomId -> room
  const roomIndex = new Map(); // owner \n hostId -> roomId
  const hostSessions = new Map(); // token -> { roomId, until }
  const clientSessions = new Map(); // token -> { roomId, cid, until }
  const joinsByIp = new Map(); // ip -> timestamps

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const error = (res, status, code, message = code, headers = {}) => json(res, status, { error: { code, message } }, headers);
  const bearer = (req) => /^bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error("too large"), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(Object.assign(new Error("bad json"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });

  /** An SSE response kept open, with pings (§2.1). */
  const openStream = (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": open\n\n");
    const timer = setInterval(() => res.write(": ping\n\n"), pingMs);
    timer.unref?.();
    const stream = {
      send: (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`),
      end: () => {
        clearInterval(timer);
        res.end();
      },
      closed: false,
    };
    req.on("close", () => {
      clearInterval(timer);
      stream.closed = true;
    });
    return stream;
  };

  const session = (map, req) => {
    const entry = map.get(bearer(req));
    if (!entry || entry.until < Date.now()) return null;
    return entry;
  };

  const toHost = (room, frame) => {
    onFrame("to-host", frame);
    room.hostStream?.send(frame);
  };
  const toClient = (room, cid, frame) => {
    const client = room.clients.get(cid);
    if (!client?.stream || client.stream.closed) return false;
    onFrame("to-client", frame);
    client.stream.send(frame);
    return true;
  };

  const routes = {
    async "POST /host/register"(req, res) {
      const credential = bearer(req);
      const account = String(req.headers["x-unieai-account"] ?? "studio");
      const origin = String(req.headers["x-unieai-origin"] ?? "");
      const body = await readBody(req);
      if (body?.protocol !== 1) return error(res, 400, "unsupported_protocol", "this relay speaks protocol 1");
      const owner = credential ? await validateHost({ account, origin, token: credential }).catch(() => null) : null;
      if (!owner) return error(res, 401, "invalid_token", "invalid token");
      const hostId = String(body.hostId ?? "").slice(0, 64);
      if (!hostId) return error(res, 400, "bad_request", "hostId is required");
      const key = `${owner}\n${hostId}`;
      let roomId = roomIndex.get(key);
      let room = roomId && rooms.get(roomId);
      if (!room) {
        roomId = token("r_");
        room = { id: roomId, owner, hostId, clients: new Map(), hostStream: null, joinToken: token(), handshakes: [] };
        rooms.set(roomId, room);
        roomIndex.set(key, roomId);
      }
      room.hostName = String(body.hostName ?? "").slice(0, 128);
      room.closed = false;
      const hostSession = token("hs_");
      const until = Date.now() + HOST_SESSION_MS;
      hostSessions.set(hostSession, { roomId, until });
      log(`[relay] host registered: room ${roomId}`);
      json(res, 200, {
        roomId,
        hostSession,
        joinToken: room.joinToken,
        webUrl: `${publicUrl ?? `http://${req.headers.host}`}/`,
        expiresAt: new Date(until).toISOString(),
      });
    },

    async "GET /host/stream"(req, res) {
      const entry = session(hostSessions, req);
      const room = entry && rooms.get(entry.roomId);
      if (!room) return error(res, 401, "invalid_token", "invalid token");
      // One host stream per room: the newest wins (§3.2).
      room.hostStream?.end();
      const stream = openStream(req, res);
      room.hostStream = stream;
      for (const [cid, client] of room.clients) {
        if (client.stream && !client.stream.closed) {
          toHost(room, { t: "open", cid });
          client.stream.send({ t: "host", state: "online" });
        }
      }
      req.on("close", () => {
        if (room.hostStream !== stream) return;
        room.hostStream = null;
        for (const cid of room.clients.keys()) toClient(room, cid, { t: "host", state: "offline" });
      });
    },

    async "POST /host/send"(req, res) {
      const entry = session(hostSessions, req);
      const room = entry && rooms.get(entry.roomId);
      if (!room) return error(res, 401, "invalid_token", "invalid token");
      const body = await readBody(req);
      const frames = Array.isArray(body?.frames) ? body.frames : [];
      if (frames.length > MAX_FRAMES) return error(res, 413, "too_large", "too many frames");
      const dropped = new Set();
      for (const frame of frames) {
        if (!frame || !E2E_TYPES.has(frame.t) || typeof frame.cid !== "string") continue;
        if (JSON.stringify(frame).length > MAX_FRAME_CHARS) continue;
        if (!toClient(room, frame.cid, frame)) dropped.add(frame.cid);
      }
      json(res, 200, { ok: true, dropped: [...dropped] });
    },

    async "POST /host/unregister"(req, res) {
      const entry = session(hostSessions, req);
      const room = entry && rooms.get(entry.roomId);
      if (!room) return error(res, 401, "invalid_token", "invalid token");
      hostSessions.delete(bearer(req));
      room.closed = true;
      for (const cid of room.clients.keys()) toClient(room, cid, { t: "host", state: "closed" });
      room.hostStream?.end();
      room.hostStream = null;
      json(res, 200, { ok: true });
    },

    async "POST /client/join"(req, res) {
      const ip = req.socket.remoteAddress ?? "";
      const recent = (joinsByIp.get(ip) ?? []).filter((at) => at > Date.now() - 60_000);
      if (recent.length >= 30) return error(res, 429, "rate_limited", "too many joins", { "retry-after": "60" });
      joinsByIp.set(ip, [...recent, Date.now()]);
      const body = await readBody(req);
      const room = rooms.get(String(body?.roomId ?? ""));
      // One answer for an unknown room and a wrong token.
      if (!room || body?.joinToken !== room.joinToken) return error(res, 404, "unknown_room", "unknown room");
      if (room.clients.size >= MAX_CLIENTS) return error(res, 403, "forbidden", "this room is full");
      const cid = token("c_");
      const clientSession = token("cs_");
      clientSessions.set(clientSession, { roomId: room.id, cid, until: Date.now() + CLIENT_SESSION_MS });
      room.clients.set(cid, { stream: null, session: clientSession });
      json(res, 200, { clientId: cid, clientSession });
    },

    async "GET /client/stream"(req, res) {
      const entry = session(clientSessions, req);
      const room = entry && rooms.get(entry.roomId);
      const client = room?.clients.get(entry.cid);
      if (!client) return error(res, 401, "invalid_token", "invalid token");
      client.stream?.end();
      const stream = openStream(req, res);
      client.stream = stream;
      entry.until = Date.now() + CLIENT_SESSION_MS;
      stream.send({ t: "host", state: room.closed ? "closed" : room.hostStream ? "online" : "offline" });
      if (room.hostStream) toHost(room, { t: "open", cid: entry.cid });
      req.on("close", () => {
        if (client.stream !== stream) return;
        client.stream = null;
        toHost(room, { t: "close", cid: entry.cid });
      });
    },

    async "POST /client/send"(req, res) {
      const entry = session(clientSessions, req);
      const room = entry && rooms.get(entry.roomId);
      if (!room?.clients.has(entry.cid)) return error(res, 401, "invalid_token", "invalid token");
      const body = await readBody(req);
      const frames = Array.isArray(body?.frames) ? body.frames : [];
      if (frames.length > MAX_FRAMES) return error(res, 413, "too_large", "too many frames");
      if (!room.hostStream) return json(res, 200, { ok: true, queued: false });
      for (const frame of frames) {
        if (!frame || !E2E_TYPES.has(frame.t)) continue;
        if (JSON.stringify(frame).length > MAX_FRAME_CHARS) continue;
        if (frame.t === "hs1") {
          const cutoff = Date.now() - 60_000;
          room.handshakes = room.handshakes.filter((at) => at > cutoff);
          if (room.handshakes.length >= HANDSHAKES_PER_MINUTE) continue;
          room.handshakes.push(Date.now());
        }
        // The relay says who sent it, whatever the browser wrote (§4.3).
        toHost(room, { ...frame, cid: entry.cid });
      }
      json(res, 200, { ok: true });
    },

    async "POST /client/leave"(req, res) {
      const entry = session(clientSessions, req);
      const room = entry && rooms.get(entry.roomId);
      if (room) {
        room.clients.get(entry.cid)?.stream?.end();
        room.clients.delete(entry.cid);
        toHost(room, { t: "close", cid: entry.cid });
      }
      clientSessions.delete(bearer(req));
      json(res, 200, { ok: true });
    },
  };

  /** The test page, the shared protocol modules, and @noble for the page. */
  const serveStatic = async (pathname, res) => {
    let file = null;
    if (pathname === "/" || pathname === "/index.html") file = join(PUBLIC_DIR, "index.html");
    else if (pathname.startsWith("/lib/") && LIB_FILES.has(pathname.slice(5))) file = join(LIB_DIR, pathname.slice(5));
    else if (pathname.startsWith("/app/")) file = join(PUBLIC_DIR, normalize(pathname.slice(5)));
    else if (pathname.startsWith("/vendor/@noble/")) file = join(NODE_MODULES, "@noble", normalize(pathname.slice("/vendor/@noble/".length)));
    const roots = [PUBLIC_DIR, LIB_DIR, join(NODE_MODULES, "@noble")];
    if (!file || !roots.some((root) => file === root || file.startsWith(root + sep)) || !CONTENT_TYPES[extname(file)]) return false;
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file)],
        "cache-control": "no-cache",
        // The page runs only its own code (§9's honest limit).
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
        "referrer-policy": "no-referrer",
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://relay");
    try {
      if (url.pathname.startsWith(`${PREFIX}/`)) {
        const route = routes[`${req.method} ${url.pathname.slice(PREFIX.length)}`];
        if (!route) return error(res, 404, "not_found");
        return await route(req, res);
      }
      if (req.method === "GET" && (await serveStatic(url.pathname, res))) return;
      error(res, 404, "not_found");
    } catch (failure) {
      if (!res.headersSent) error(res, failure.status ?? 500, failure.status === 413 ? "too_large" : "bad_request", failure.message);
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const origin = `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`;
  publicUrl ??= origin;
  return {
    url: publicUrl,
    relayUrl: `${publicUrl}${PREFIX}`,
    rooms,
    close: () =>
      new Promise((resolve) => {
        for (const room of rooms.values()) {
          room.hostStream?.end();
          for (const client of room.clients.values()) client.stream?.end();
        }
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
