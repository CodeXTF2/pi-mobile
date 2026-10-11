// Minimal Web Push sender (RFC 8291 payload encryption + RFC 8292 VAPID), using only
// node:crypto so there is no extra dependency. The browser's push service (FCM on
// Chrome for Android) holds the message until the phone wakes, which a LAN WebSocket
// can't do once Chrome freezes the backgrounded page. Payloads are end-to-end
// encrypted: the push service only sees size and timing.

import crypto from "node:crypto";
import fs from "node:fs";
import { readJSON } from "./paths.mjs";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s || ""), "base64url");

// VAPID key pair, created once and kept in state/. Changing it invalidates every
// subscription, so it is never rotated automatically.
export function loadVapid(file) {
  let jwk = readJSON(file, null);
  if (!jwk?.d || !jwk?.x || !jwk?.y) {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    jwk = privateKey.export({ format: "jwk" });
    fs.writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
  }
  return {
    key: crypto.createPrivateKey({ key: jwk, format: "jwk" }),
    // Uncompressed point (0x04 || X || Y): the browser's applicationServerKey.
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])),
  };
}

function vapidAuth(vapid, endpoint) {
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: "mailto:pi-mobile@example.com",
  }));
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), { key: vapid.key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// aes128gcm content coding with a single record (RFC 8188 / 8291).
function encrypt(sub, payload) {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const authSecret = fromB64u(sub.keys.auth);
  const ecdh = crypto.createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export function validSubscription(sub) {
  try {
    return new URL(sub.endpoint).protocol === "https:"
      && fromB64u(sub.keys.p256dh).length === 65
      && fromB64u(sub.keys.auth).length === 16;
  } catch { return false; }
}

// Resolves to "ok", "gone" (subscription expired or revoked: forget it) or "error".
// `topic` collapses queued messages so a phone that was offline gets one per topic.
export async function sendPush(vapid, sub, data, { ttl = 3600, topic } = {}) {
  const headers = {
    "content-type": "application/octet-stream",
    "content-encoding": "aes128gcm",
    ttl: String(ttl),
    urgency: "high", // wake the phone from Doze promptly
    authorization: vapidAuth(vapid, sub.endpoint),
  };
  if (topic) headers.topic = crypto.createHash("sha256").update(topic).digest("base64url").slice(0, 32);
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers,
      body: encrypt(sub, Buffer.from(JSON.stringify(data))),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}
