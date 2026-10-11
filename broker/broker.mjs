#!/usr/bin/env node
// Pi Mobile broker.
//
// A single long-lived process that:
//   - owns the LAN TLS cert (self-signed CA + leaf)
//   - accepts loopback connections from pi extensions (one per open session)
//   - serves the PWA over HTTPS + a plain-HTTP bootstrap for CA install
//   - relays prompts phone -> session and events session -> phone
//   - fans out "turn complete" settle events to paired phones
//
// It is spawned detached by the extension the first time a pi session starts,
// and it outlives individual pi sessions. Run standalone with `npm run broker`.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

import {
  ensureStateDir,
  loadConfig,
  getOrCreateSecret,
  readJSON,
  writeJSON,
  readText,
  lanIPv4s,
  lanInterfaces,
  primaryHost,
  FILES,
  PWA_DIR,
  STATE_DIR,
} from "./lib/paths.mjs";
import { createCA, issueLeaf, sanSignature } from "./lib/certs.mjs";
import { loadVapid, sendPush, validSubscription } from "./lib/webpush.mjs";

const argv = process.argv.slice(2);

// ---- CLI subcommands (stop/status) -------------------------------------------------
if (argv.includes("--stop")) {
  const rt = readJSON(FILES.runtime, null);
  if (rt?.pid) {
    try {
      process.kill(rt.pid);
      console.log(`Stopped broker (pid ${rt.pid}).`);
    } catch (e) {
      console.log(`No running broker (stale pid ${rt.pid}).`);
    }
    try { fs.rmSync(FILES.runtime); } catch {}
  } else {
    console.log("Broker not running.");
  }
  process.exit(0);
}
if (argv.includes("--status")) {
  const rt = readJSON(FILES.runtime, null);
  if (rt?.pid && isAlive(rt.pid)) {
    console.log(JSON.stringify(rt, null, 2));
  } else {
    console.log("Broker not running.");
  }
  process.exit(0);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---- Setup -------------------------------------------------------------------------
ensureStateDir();
const config = loadConfig();
const SECRET = getOrCreateSecret();
// Web Push is on unless state/config.json sets "webPush": false (LAN-only mode).
const VAPID = config.webPush === false ? null : loadVapid(FILES.vapid);
// Sessions that asked for Web Push with /notify. Push is off unless a session opts in;
// an open page is notified over the local socket either way. Kept by session id so it
// survives pi and broker restarts.
const notifySessions = new Set(readJSON(FILES.notify, { sessions: [] }).sessions || []);
function setNotify(sessionId, on) {
  notifySessions.delete(sessionId);
  if (on) notifySessions.add(sessionId);
  // Newest last; drop the oldest so sessions that are long gone don't pile up.
  const list = [...notifySessions].slice(-500);
  writeJSON(FILES.notify, { sessions: list });
}

const certs = ensureCerts();
// Short CA fingerprint (first 8 bytes of SHA-256), shown in pi's QR overlay and on the
// bootstrap page so the user can confirm the certificate they install is really this PC's.
const CA_FINGERPRINT = (() => {
  try {
    const hex = new crypto.X509Certificate(certs.caCert).fingerprint256.replace(/:/g, "");
    return hex.slice(0, 16).match(/.{4}/g).join(" ");
  } catch { return ""; }
})();
const LOGO_SVG = (() => { try { return fs.readFileSync(path.join(PWA_DIR, "icons", "logo.svg"), "utf8"); } catch { return ""; } })();
const pairings = new Map(); // code -> { expiresAt }

// sessionId -> { meta, blocks, status, ext }
const sessions = new Map();
const phones = new Set(); // phone WS sockets (authenticated)
const exts = new Set(); // extension loopback sockets

function sessionMeta(s) {
  return {
    id: s.meta.id,
    name: s.meta.name || s.meta.cwd?.split(/[\\/]/).pop() || s.meta.id.slice(0, 8),
    cwd: s.meta.cwd,
    model: s.status?.model,
    thinkingLevel: s.status?.thinkingLevel || s.meta.thinkingLevel,
    vision: s.status?.vision,
    context: s.status?.context,
    pid: s.meta.pid,
    status: s.status?.working ? "working" : "idle",
    working: !!s.status?.working,
    lastActivity: s.lastActivity,
    blockCount: s.blocks.length,
    notify: notifySessions.has(s.meta.id),
  };
}

function sessionsList() {
  return [...sessions.values()]
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    .map(sessionMeta);
}

function broadcastPhones(msg) {
  const data = JSON.stringify(msg);
  for (const ws of phones) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function pushSessions() {
  broadcastPhones({ t: "sessions", sessions: sessionsList() });
}

// ---- Certificates ------------------------------------------------------------------
function ensureCerts() {
  let caCert = readText(FILES.caCert);
  let caKey = readText(FILES.caKey);
  if (!caCert || !caKey) {
    const ca = createCA();
    fs.writeFileSync(FILES.caCert, ca.certPem);
    fs.writeFileSync(FILES.caKey, ca.keyPem, { mode: 0o600 });
    caCert = ca.certPem;
    caKey = ca.keyPem;
  }

  const ips = [...new Set([...lanIPv4s(), "127.0.0.1"])];
  const hostnames = ["localhost"];
  const want = sanSignature({ ips, hostnames });
  const meta = readJSON(FILES.certMeta, null);

  let leafCert = readText(FILES.leafCert);
  let leafKey = readText(FILES.leafKey);
  if (!leafCert || !leafKey || !meta || meta.san !== want) {
    const leaf = issueLeaf(caCert, caKey, { ips, hostnames });
    fs.writeFileSync(FILES.leafCert, leaf.certPem);
    fs.writeFileSync(FILES.leafKey, leaf.keyPem, { mode: 0o600 });
    writeJSON(FILES.certMeta, { san: want, ips, hostnames, issuedAt: Date.now() });
    leafCert = leaf.certPem;
    leafKey = leaf.keyPem;
  }
  return { caCert, caKey, leafCert, leafKey };
}

// ---- Device store (paired phones) --------------------------------------------------
// "Mozilla/5.0 (Linux; Android 14; Pixel 7…" -> "Android 14 phone"
function deviceName(ua) {
  const m = String(ua || "").match(/Android \d+(\.\d+)?/) || String(ua || "").match(/iPhone|iPad/);
  return m ? (m[0].startsWith("Android") ? `${m[0]} phone` : m[0]) : "phone";
}
function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

class DeviceStore {
  constructor() {
    this.map = readJSON(FILES.devices, { devices: {} }).devices || {};
  }
  save() {
    writeJSON(FILES.devices, { devices: this.map });
  }
  issue(label) {
    const token = crypto.randomBytes(32).toString("hex");
    const id = crypto.randomBytes(6).toString("hex");
    this.map[id] = {
      id,
      label: label || "Phone",
      tokenHash: sha256(token),
      createdAt: Date.now(),
      lastSeen: null,
    };
    this.save();
    return { token, id };
  }
  validate(token) {
    if (!token) return null;
    const h = sha256(token);
    for (const id of Object.keys(this.map)) {
      if (this.map[id].tokenHash === h) {
        this.map[id].lastSeen = Date.now();
        this.save();
        return this.map[id];
      }
    }
    return null;
  }
  list() {
    return Object.values(this.map).map(({ id, label, createdAt, lastSeen }) => ({
      id, label, createdAt, lastSeen,
    }));
  }
  setPush(id, sub) {
    const d = this.map[id];
    if (!d || JSON.stringify(d.push) === JSON.stringify(sub)) return;
    if (sub) d.push = sub; else delete d.push;
    this.save();
  }
  revoke(id) {
    if (this.map[id]) {
      delete this.map[id];
      this.save();
      return true;
    }
    return false;
  }
}

const devices = new DeviceStore();

// ---- Pairing codes -----------------------------------------------------------------
const PAIRING_TTL_MS = 5 * 60 * 1000;

function createPairing() {
  const code = crypto.randomBytes(6).toString("hex");
  pairings.set(code, { expiresAt: Date.now() + PAIRING_TTL_MS });
  return code;
}

function consumePairing(code) {
  const p = pairings.get(code);
  if (!p) return false;
  pairings.delete(code);
  if (Date.now() > p.expiresAt) return false;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, p] of pairings) if (now > p.expiresAt) pairings.delete(code);
}, 60 * 1000).unref();

// ---- Extension loopback server (127.0.0.1) -----------------------------------------
const loopbackServer = http.createServer();
const loopbackWss = new WebSocketServer({ server: loopbackServer });

loopbackWss.on("connection", (ws, req) => {
  // Only accept loopback connections.
  const ra = req.socket.remoteAddress || "";
  if (!(ra.includes("127.0.0.1") || ra === "::1" || ra.endsWith(":127.0.0.1"))) {
    ws.close();
    return;
  }
  let authed = false;
  const owned = new Set(); // sessionIds owned by this socket

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (!authed) {
      if (msg.t === "hello" && msg.secret === SECRET) {
        authed = true;
        exts.add(ws);
        ws.send(JSON.stringify({ t: "welcome", loopbackOk: true }));
        if (msg.session) registerSession(ws, msg.session, owned);
        return;
      }
      ws.close();
      return;
    }

    handleExtMessage(ws, msg, owned);
  });

  ws.on("close", () => {
    exts.delete(ws);
    for (const id of owned) {
      sessions.delete(id);
      broadcastPhones({ t: "session-removed", sessionId: id });
    }
    pushSessions();
  });
});

function registerSession(ws, session, owned) {
  const existing = sessions.get(session.id);
  const s = existing || { meta: {}, blocks: [], status: {}, ext: ws };
  s.meta = { ...s.meta, ...session };
  s.ext = ws;
  s.lastActivity = Date.now();
  if (!s.status) s.status = {};
  s.status.model = session.model;
  s.status.name = session.name;
  s.status.thinkingLevel = session.thinkingLevel;
  sessions.set(session.id, s);
  owned.add(session.id);
  pushSessions();
}

function handleExtMessage(ws, msg, owned) {
  switch (msg.t) {
    case "hello": {
      if (msg.session) registerSession(ws, msg.session, owned);
      break;
    }
    case "snapshot": {
      const s = sessions.get(msg.sessionId);
      if (s) {
        s.blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
        if (msg.status) s.status = { ...s.status, ...msg.status };
        s.lastActivity = Date.now();
        broadcastPhones({ t: "snapshot", sessionId: msg.sessionId, blocks: s.blocks, status: s.status });
        pushSessions();
      }
      break;
    }
    case "block": {
      const s = sessions.get(msg.sessionId);
      if (s && msg.block) {
        s.blocks.push(msg.block);
        if (s.blocks.length > 2000) s.blocks.splice(0, s.blocks.length - 2000);
        s.lastActivity = Date.now();
        broadcastPhones({ t: "block", sessionId: msg.sessionId, block: msg.block });
      }
      break;
    }
    case "status": {
      const s = sessions.get(msg.sessionId);
      if (s) {
        s.status = { ...s.status, ...msg.status };
        s.lastActivity = Date.now();
        broadcastPhones({ t: "status", sessionId: msg.sessionId, status: s.status });
        pushSessions();
      }
      break;
    }
    case "settled": {
      const s = sessions.get(msg.sessionId);
      if (s) {
        s.status = { ...s.status, working: false };
        s.lastActivity = Date.now();
      }
      const settled = {
        t: "settled",
        sessionId: msg.sessionId,
        aborted: !!msg.aborted,
        title: msg.title || "Pi turn complete",
        body: msg.body || "",
      };
      const pushed = settled.aborted ? new Set() : pushSettled(settled);
      // Tell each page whether its phone got a push, so it doesn't notify a second time.
      for (const ws of phones) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ...settled, push: pushed.has(ws.device.id) }));
      }
      broadcastPhones({ t: "status", sessionId: msg.sessionId, status: s?.status || { working: false } });
      pushSessions();
      break;
    }
    case "create-pairing": {
      const code = createPairing();
      const host = primaryHost();
      ws.send(JSON.stringify({
        t: "pairing",
        reqId: msg.reqId,
        host,
        hosts: lanIPv4s(),
        hostOptions: lanInterfaces(),
        httpsPort: config.httpsPort,
        httpPort: config.httpPort,
        bootstrapUrl: host ? `http://${host}:${config.httpPort}/pair#${code}` : null,
        httpsUrl: host ? `https://${host}:${config.httpsPort}/#${code}` : null,
        code,
        expiresInSec: PAIRING_TTL_MS / 1000,
        caFingerprint: CA_FINGERPRINT,
      }));
      break;
    }
    case "set-notify":
    case "get-notify": {
      const id = String(msg.sessionId || "");
      if (msg.t === "set-notify" && id) {
        setNotify(id, typeof msg.on === "boolean" ? msg.on : !notifySessions.has(id));
        pushSessions();
      }
      ws.send(JSON.stringify({
        t: "notify", reqId: msg.reqId, sessionId: id, on: notifySessions.has(id),
        webPush: !!VAPID, devices: Object.values(devices.map).filter((d) => d.push).length,
      }));
      break;
    }
    case "list-devices": {
      ws.send(JSON.stringify({ t: "devices", reqId: msg.reqId, devices: devices.list() }));
      break;
    }
    case "revoke-device": {
      const ok = devices.revoke(msg.deviceId);
      if (ok) disconnectDevice(msg.deviceId);
      ws.send(JSON.stringify({ t: "revoked", reqId: msg.reqId, deviceId: msg.deviceId, ok }));
      break;
    }
    case "revoke-all-devices": {
      const ids = Object.keys(devices.map);
      for (const id of ids) { devices.revoke(id); disconnectDevice(id); }
      ws.send(JSON.stringify({ t: "revoked", reqId: msg.reqId, count: ids.length, ok: true }));
      break;
    }
    // slash-command results and command lists go to every phone
    case "command-result": {
      const s = sessions.get(msg.sessionId);
      if (!s) break;
      // Keep the cached command row current for phones that connect later.
      const b = s.blocks.find((x) => x.kind === "command" && x.reqId === msg.reqId);
      if (b) b.result = { ok: msg.ok, pending: !!msg.pending, text: msg.text || "", ...(msg.choices ? { choices: msg.choices } : {}) };
      broadcastPhones(msg);
      break;
    }
    case "commands": {
      if (sessions.has(msg.sessionId)) broadcastPhones(msg);
      break;
    }
    case "bye": {
      if (msg.sessionId) {
        sessions.delete(msg.sessionId);
        owned.delete(msg.sessionId);
        broadcastPhones({ t: "session-removed", sessionId: msg.sessionId });
        pushSessions();
      }
      break;
    }
  }
}

function relayToSession(sessionId, obj) {
  const s = sessions.get(sessionId);
  if (!s || !s.ext || s.ext.readyState !== s.ext.OPEN) return false;
  s.ext.send(JSON.stringify(obj));
  return true;
}

function injectPrompt(sessionId, text, deliverAs, images, files) {
  return relayToSession(sessionId, { t: "prompt", sessionId, text, deliverAs, images, files });
}

// ---- attachments from the phone ----------------------------------------------------
// Images travel inline (base64) with the prompt and become image content for the model.
// Other files are uploaded first over HTTPS and saved here; the prompt references them by path.
const UPLOAD_DIR = path.join(STATE_DIR, "uploads");
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_IMAGES = 8;
const MAX_IMAGE_B64 = 14 * 1024 * 1024; // ~10 MB decoded

function cleanImages(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_IMAGES).filter((im) =>
    im && typeof im.data === "string" && im.data.length <= MAX_IMAGE_B64 &&
    /^image\/(png|jpeg|gif|webp)$/.test(im.mimeType || "") && /^[A-Za-z0-9+/=]+$/.test(im.data.slice(0, 200))
  ).map((im) => ({ data: im.data, mimeType: im.mimeType }));
}
function cleanFiles(list) {
  if (!Array.isArray(list)) return [];
  const root = path.resolve(UPLOAD_DIR) + path.sep;
  // Only paths this broker wrote are accepted, so the phone can't point the agent elsewhere.
  return list.slice(0, 20).filter((f) => f && typeof f.path === "string" && path.resolve(f.path).startsWith(root) && fs.existsSync(f.path))
    .map((f) => ({ path: path.resolve(f.path), name: String(f.name || path.basename(f.path)).slice(0, 200), size: Number(f.size) || 0, mimeType: String(f.mimeType || "") }));
}
function safeFileName(name) {
  const base = String(name || "file").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(-120);
  return base || "file";
}
async function handleUpload(req, res, url) {
  const token = req.headers["x-pi-token"] || new URL(url, "https://x").searchParams.get("token");
  if (!devices.validate(token)) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
  const q = new URL(url, "https://x").searchParams;
  const name = safeFileName(q.get("name"));
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_UPLOAD_BYTES) { res.writeHead(413, { "content-type": "application/json" }); res.end('{"error":"too_large"}'); return; }
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(UPLOAD_DIR, day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomBytes(4).toString("hex")}-${name}`);
  const out = fs.createWriteStream(file);
  let size = 0, failed = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES && !failed) {
      failed = true; req.unpipe(out); out.destroy(); fs.rm(file, { force: true }, () => {});
      res.writeHead(413, { "content-type": "application/json" }); res.end('{"error":"too_large"}');
      req.destroy();
    }
  });
  req.pipe(out);
  out.on("finish", () => {
    if (failed) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: file, name, size, mimeType: req.headers["content-type"] || "" }));
  });
  out.on("error", () => {
    if (failed) return; failed = true;
    res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"write_failed"}');
  });
}

// ---- Static file serving for the PWA -----------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const full = path.join(PWA_DIR, rel);
  if (!full.startsWith(PWA_DIR)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-cache",
      "service-worker-allowed": "/",
    });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(data));
  });
}

// ---- HTTPS server (PWA + REST + phone WSS) ------------------------------------------
const httpsServer = https.createServer(
  { cert: certs.leafCert, key: certs.leafKey },
  async (req, res) => {
    const url = req.url || "/";
    cors(res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (url.startsWith("/api/pair") && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!consumePairing(body.code)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_or_expired_code" }));
        return;
      }
      const { token, id } = devices.issue(deviceName(body.label));
      // Let open pi sessions know, so the QR overlay can confirm and close itself.
      for (const ext of exts) { try { ext.send(JSON.stringify({ t: "paired", deviceId: id, label: deviceName(body.label) })); } catch {} }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token, deviceId: id }));
      return;
    }

    if (url.startsWith("/api/upload") && req.method === "POST") {
      await handleUpload(req, res, url);
      return;
    }

    if (url.startsWith("/api/ping")) {
      const token = new URL(url, "https://x").searchParams.get("token");
      const ok = !!devices.validate(token);
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok }));
      return;
    }

    serveStatic(req, res, url);
  }
);

const phoneWss = new WebSocketServer({ noServer: true });

httpsServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "https://x");
  if (url.pathname !== "/ws") { socket.destroy(); return; }
  const device = devices.validate(url.searchParams.get("token"));
  phoneWss.handleUpgrade(req, socket, head, (ws) => {
    // A browser can't read an HTTP 401 on a WebSocket upgrade, only a close code, so an
    // unknown or revoked token is told with 4401 and the page goes back to pairing.
    if (!device) { ws.close(4401, "unpaired"); return; }
    ws.device = device;
    onPhone(ws);
  });
});

// Drop a revoked device's open pages right away; 4401 sends them back to pairing.
function disconnectDevice(id) {
  for (const ws of phones) {
    if (ws.device?.id === id) ws.close(4401, "revoked");
  }
}

// ---- Web Push --------------------------------------------------------------------
// Web Push is the only source of system notifications (the page no longer shows its
// own from the WebSocket, since Chrome freezes it a few minutes into the background).
// For a session opted in with /notify, every phone whose page isn't in use (visible
// and focused) gets a push. Returns the ids of the devices pushed to.
function pushSettled(settled) {
  const out = new Set();
  if (!VAPID || !notifySessions.has(settled.sessionId)) return out;
  const visible = new Set([...phones].filter((ws) => ws.visible && ws.readyState === ws.OPEN).map((ws) => ws.device.id));
  for (const d of Object.values(devices.map)) {
    if (!d.push || visible.has(d.id)) continue;
    out.add(d.id);
    const data = { title: settled.title, body: String(settled.body).slice(0, 500), sessionId: settled.sessionId };
    sendPush(VAPID, d.push, data, { ttl: 6 * 3600, topic: settled.sessionId }).then((r) => {
      if (r === "gone") devices.setPush(d.id, null);
      else if (r === "error") console.error(`[pi-mobile] push to ${d.label} (${d.id}) failed`);
    });
  }
  return out;
}

function onPhone(ws) {
  phones.add(ws);
  ws.visible = false; // "in use" (visible and focused), until the page says otherwise
  ws.send(JSON.stringify({ t: "sessions", sessions: sessionsList() }));
  if (VAPID) ws.send(JSON.stringify({ t: "push-key", key: VAPID.publicKey }));
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.t) {
      case "subscribe":
        ws.send(JSON.stringify({ t: "sessions", sessions: sessionsList() }));
        break;
      case "visibility":
        ws.visible = !!msg.visible;
        break;
      case "push-subscribe": {
        const sub = msg.subscription;
        const ok = !!VAPID && validSubscription(sub);
        if (ok) devices.setPush(ws.device.id, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
        else if (sub === null) devices.setPush(ws.device.id, null);
        break;
      }
      case "get-snapshot": {
        const s = sessions.get(msg.sessionId);
        if (s) {
          // Ask the owning extension for a fresh snapshot, and also send cached.
          if (s.ext?.readyState === s.ext.OPEN) {
            s.ext.send(JSON.stringify({ t: "request-snapshot", sessionId: msg.sessionId }));
          }
          ws.send(JSON.stringify({ t: "snapshot", sessionId: msg.sessionId, blocks: s.blocks, status: s.status }));
        }
        break;
      }
      case "send-prompt": {
        const deliverAs = msg.deliverAs === "steer" || msg.deliverAs === "followUp" ? msg.deliverAs : undefined;
        const ok = injectPrompt(msg.sessionId, String(msg.text || ""), deliverAs, cleanImages(msg.images), cleanFiles(msg.files));
        ws.send(JSON.stringify({ t: "prompt-echo", sessionId: msg.sessionId, text: msg.text, ok }));
        break;
      }
      case "run-command": {
        const text = String(msg.text || "");
        const reqId = String(msg.reqId || crypto.randomBytes(4).toString("hex"));
        const ok = /^\/\S/.test(text) && relayToSession(msg.sessionId, { t: "command", sessionId: msg.sessionId, text, reqId });
        if (!ok) ws.send(JSON.stringify({ t: "command-result", sessionId: msg.sessionId, reqId, ok: false, text: "Session offline." }));
        break;
      }
      case "get-commands": {
        relayToSession(msg.sessionId, { t: "get-commands", sessionId: msg.sessionId });
        break;
      }
      case "stop": {
        const ok = relayToSession(msg.sessionId, { t: "stop", sessionId: msg.sessionId });
        ws.send(JSON.stringify({ t: "stop-ack", sessionId: msg.sessionId, ok }));
        break;
      }
    }
  });
  ws.on("close", () => phones.delete(ws));
}

function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

// ---- HTTP bootstrap server (CA install, pre-trust) ---------------------------------
const httpServer = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url === "/ca.crt") {
    res.writeHead(200, {
      "content-type": "application/x-x509-ca-cert",
      "content-disposition": "attachment; filename=pi-mobile-ca.crt",
    });
    res.end(certs.caCert);
    return;
  }
  // Lets the bootstrap page show a countdown; reveals nothing without the code itself.
  if (url.startsWith("/pair-status")) {
    const code = new URL(url, "http://x").searchParams.get("code") || "";
    const p = pairings.get(code);
    const left = p ? Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000)) : 0;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ valid: left > 0, expiresInSec: left }));
    return;
  }
  if (url.startsWith("/pair-info")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ host: primaryHost(), httpsPort: config.httpsPort }));
    return;
  }
  // bootstrap landing page
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(bootstrapHtml());
});

function bootstrapHtml() {
  const httpsPort = config.httpsPort;
  const logo = LOGO_SVG.replace("<svg ", '<svg class="logo" aria-hidden="true" ');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111720">
<title>Pair pi mobile</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap">
<style>
  :root{color-scheme:dark;--bg:#0c0c0c;--panel:#141414;--panel2:#1b1b1b;--line:#262626;--text:#cccccc;--hi:#e6e6e6;--dim:#7e888e;--dim2:#555b5f;
    --rule:#6185cc;--accent:#a798d7;--ok:#68b78d;--warn:#ffaa00;--err:#e06c75;--coral:#f09082;--blue:#4d9abf;--yellow:#f1be58;
    --mono:"JetBrains Mono",ui-monospace,"Cascadia Mono",Menlo,"Roboto Mono","Droid Sans Mono",Consolas,monospace}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;min-height:100%}
  body{background-color:#111720;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);
    background-size:24px 24px;background-position:-1px -1px;color:var(--text);font:14px/1.55 var(--mono);font-variant-ligatures:none;
    padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(28px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
  main{max-width:560px;margin:0 auto}
  header{display:flex;align-items:center;gap:12px;margin:8px 0 18px}
  .logo{width:40px;height:40px;flex:none}
  h1{margin:0;font-size:20px;color:var(--hi);letter-spacing:-.02em}
  .tag{color:var(--dim);font-size:12px}
  .meta{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--dim);margin:0 0 14px;padding:8px 12px;background:var(--bg);border:1px solid var(--line);border-left:2px solid var(--rule);border-radius:3px}
  .meta b{color:var(--hi);font-weight:600}
  .meta .exp.low b{color:var(--warn)} .meta .exp.gone b{color:var(--err)}
  .step{background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--dim2);border-radius:3px;padding:14px 14px 14px 14px;margin:0 0 12px}
  .step.done{border-left-color:var(--ok)} .step.next{border-left-color:var(--rule)}
  .head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .n{flex:none;width:22px;height:22px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;background:var(--panel2);color:var(--dim);border:1px solid var(--line)}
  .done .n{background:var(--ok);border-color:var(--ok);color:#0c0c0c} .next .n{background:var(--rule);border-color:var(--rule);color:#0c0c0c}
  .title{color:var(--hi);font-weight:700;flex:1}
  .pill{flex:none;font-size:11.5px;padding:2px 8px;border-radius:3px;border:1px solid var(--line);color:var(--dim)}
  .pill.ok{color:var(--ok);border-color:#2c4d3b} .pill.no{color:var(--warn);border-color:#4d3a10}
  p{margin:6px 0;font-size:13px}
  .dim{color:var(--dim)}
  ol{margin:8px 0 4px;padding-left:20px;font-size:13px} li{margin:4px 0} li::marker{color:var(--blue)}
  b.k{color:var(--hi)}
  .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:12px;padding:12px;border-radius:3px;font:700 14px var(--mono);text-decoration:none;cursor:pointer;
    background:transparent;color:var(--rule);border:1px solid var(--rule)}
  .btn.primary{background:var(--rule);color:#0c0c0c}
  .btn:active{transform:scale(.99)}
  .fp{margin-top:10px;font-size:12px;color:var(--dim)} .fp code{color:var(--yellow);font-family:var(--mono);letter-spacing:.04em}
  .url{margin-top:8px;font-size:11.5px;color:var(--dim);word-break:break-all} .url code{color:var(--text)}
  .banner{display:none;margin:0 0 12px;padding:10px 12px;border-radius:3px;font-size:13px;background:#241416;border:1px solid #4a2328;color:#f0b4ba}
  .banner b{color:#fff}
  footer{margin-top:18px;font-size:12px;color:var(--dim);text-align:center}
  footer code,.cmd{color:var(--hi)} .cmd .p{color:var(--coral)}
  .spin{width:10px;height:10px;border:2px solid var(--dim2);border-top-color:var(--accent);border-radius:50%;animation:s .8s linear infinite;display:inline-block;vertical-align:-1px}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head><body><main>
<header>${logo}<div><h1>pi mobile</h1><div class="tag">pair this phone with your PC</div></div></header>

<div class="banner" id="expired"><b>This pairing code has expired.</b> On your PC run <span class="cmd"><span class="p">❯</span> /mobileauth</span> and scan the new QR code.</div>
<div class="banner" id="nocode"><b>No pairing code.</b> Open this page by scanning the QR code from <span class="cmd"><span class="p">❯</span> /mobileauth</span> in pi.</div>

<div class="meta"><span>pc <b id="host"></b></span><span class="exp" id="exp">code valid <b id="left">…</b></span></div>

<section class="step next" id="s1">
  <div class="head"><span class="n">1</span><span class="title">Trust your PC</span><span class="pill" id="trust"><span class="spin"></span> checking</span></div>
  <p class="dim">One time only. Installs a certificate made on your PC so the connection to it is encrypted.</p>
  <a class="btn primary" id="dl" href="/ca.crt" download="pi-mobile-ca.crt">↓ download certificate</a>
  <ol>
    <li>Open <b class="k">Settings</b> and search for <b class="k">CA certificate</b></li>
    <li>Tap <b class="k">Install anyway</b>, then pick <b class="k">pi-mobile-ca.crt</b> from Downloads</li>
    <li>Come back here. This page notices automatically.</li>
  </ol>
  <div class="fp">fingerprint <code>${CA_FINGERPRINT || "unavailable"}</code><br><span class="dim">should match the one shown under the QR code in pi</span></div>
</section>

<section class="step" id="s2">
  <div class="head"><span class="n">2</span><span class="title">Open pi mobile</span></div>
  <p class="dim">Finishes pairing over the encrypted connection. Then add it to your home screen from Chrome's menu.</p>
  <button class="btn" id="go">open pi mobile →</button>
  <div class="url">or open <code id="target"></code></div>
</section>

<footer>Wrong network or nothing loads? Make sure the phone is on the same Wi-Fi as your PC.</footer>
</main>
<script>
(function(){
  var PORT = ${httpsPort};
  var code = location.hash.replace(/^#/, "");
  var host = location.hostname;
  var target = "https://" + host + ":" + PORT + "/#" + code;
  var $ = function(id){ return document.getElementById(id); };
  $("host").textContent = host;
  $("target").textContent = target;
  $("go").onclick = function(){ location.href = target; };
  if (!code) { $("nocode").style.display = "block"; $("exp").style.display = "none"; }

  // Step 1 state: can this phone reach the HTTPS app with a trusted certificate?
  var trusted = null, timer = null;
  function setTrust(ok){
    if (ok === trusted) return;
    trusted = ok;
    var pill = $("trust");
    pill.className = "pill " + (ok ? "ok" : "no");
    pill.textContent = ok ? "✓ trusted" : "not yet";
    $("s1").className = "step " + (ok ? "done" : "next");
    $("s2").className = "step" + (ok ? " next" : "");
    $("go").className = "btn" + (ok ? " primary" : "");
    $("dl").className = "btn" + (ok ? "" : " primary");
    if (ok && timer) { clearInterval(timer); timer = null; }
  }
  function check(){
    // Any HTTP answer (even 401) means TLS succeeded, i.e. the certificate is trusted.
    fetch("https://" + host + ":" + PORT + "/api/ping?t=" + Date.now(), { cache: "no-store" })
      .then(function(){ setTrust(true); }, function(){ setTrust(false); });
  }
  check();
  timer = setInterval(function(){ if (!document.hidden) check(); }, 3000);
  document.addEventListener("visibilitychange", function(){ if (!document.hidden) check(); });

  // Code countdown
  var left = null;
  function fmt(s){ return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }
  function paint(){
    if (left == null) return;
    var el = $("exp");
    if (left <= 0) { $("left").textContent = "expired"; el.className = "exp gone"; $("expired").style.display = "block"; return; }
    $("left").textContent = fmt(left);
    el.className = "exp" + (left < 60 ? " low" : "");
  }
  function status(){
    if (!code) return;
    fetch("/pair-status?code=" + encodeURIComponent(code), { cache: "no-store" })
      .then(function(r){ return r.json(); })
      .then(function(j){ left = j.valid ? j.expiresInSec : 0; paint(); })
      .catch(function(){});
  }
  status();
  setInterval(function(){ if (left > 0) { left--; paint(); } }, 1000);
  setInterval(status, 15000);
})();
</script>
</body></html>`;
}

// ---- Boot ---------------------------------------------------------------------------
loopbackServer.listen(config.loopbackPort, "127.0.0.1", () => {
  // We are the singleton. Start the public listeners.
  httpsServer.listen(config.httpsPort, "0.0.0.0");
  httpServer.listen(config.httpPort, "0.0.0.0");
  const rt = {
    pid: process.pid,
    host: primaryHost(),
    hosts: lanIPv4s(),
    httpsPort: config.httpsPort,
    httpPort: config.httpPort,
    loopbackPort: config.loopbackPort,
    startedAt: Date.now(),
  };
  writeJSON(FILES.runtime, rt);
  console.log(`[pi-mobile] broker up. host=${rt.host} https=${rt.httpsPort} http=${rt.httpPort} loopback=${rt.loopbackPort}`);
});

loopbackServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("[pi-mobile] broker already running.");
    process.exit(0);
  } else {
    console.error("[pi-mobile] fatal:", err);
    process.exit(1);
  }
});

// Remove the runtime file only if it describes *this* process. A second broker that
// exits on EADDRINUSE must not delete the live broker's file (that hid its pid from --stop).
function removeOwnRuntime() {
  try { if (readJSON(FILES.runtime, null)?.pid === process.pid) fs.rmSync(FILES.runtime); } catch {}
}
function shutdown() {
  removeOwnRuntime();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", removeOwnRuntime);
