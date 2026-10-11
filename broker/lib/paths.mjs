// Filesystem layout and small persistence helpers. Everything lives under the
// project's own `state/` directory so nothing leaks into other folders.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, "..", "..");
export const STATE_DIR = path.join(PROJECT_ROOT, "state");
export const PWA_DIR = path.join(PROJECT_ROOT, "pwa");

export const FILES = {
  config: path.join(STATE_DIR, "config.json"),
  secret: path.join(STATE_DIR, "secret"),
  caCert: path.join(STATE_DIR, "ca.crt"),
  caKey: path.join(STATE_DIR, "ca.key"),
  leafCert: path.join(STATE_DIR, "server.crt"),
  leafKey: path.join(STATE_DIR, "server.key"),
  certMeta: path.join(STATE_DIR, "cert-meta.json"),
  devices: path.join(STATE_DIR, "devices.json"),
  vapid: path.join(STATE_DIR, "vapid.json"), // Web Push signing key
  notify: path.join(STATE_DIR, "notify.json"), // sessions opted in to Web Push (/notify)
  runtime: path.join(STATE_DIR, "broker.json"), // live {pid, ports, host}
};

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export const DEFAULT_CONFIG = {
  httpsPort: 47443,
  httpPort: 47080,
  loopbackPort: 47799,
};

export function loadConfig() {
  return { ...DEFAULT_CONFIG, ...readJSON(FILES.config, {}) };
}

export function getOrCreateSecret() {
  let secret = readText(FILES.secret);
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(FILES.secret, secret, { mode: 0o600 });
  }
  return secret.trim();
}

// Non-internal IPv4 interfaces as { name, address }, best-effort LAN first.
export function lanInterfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === "IPv4" && !info.internal) out.push({ name, address: info.address });
    }
  }
  // Prefer common private ranges (likely the Wi-Fi/LAN the phone shares).
  out.sort((a, b) => rank(a.address) - rank(b.address));
  return out;
}

// Non-internal IPv4 addresses, best-effort LAN address first.
export function lanIPv4s() {
  return lanInterfaces().map((i) => i.address);
}

function rank(ip) {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

export function primaryHost() {
  return lanIPv4s()[0];
}
