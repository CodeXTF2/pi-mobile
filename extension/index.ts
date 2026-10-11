/**
 * Pi Mobile — pi.dev extension
 *
 * Loaded inside every pi session. It:
 *   - ensures the shared broker is running (spawns it detached once)
 *   - registers the live session so the phone can see it
 *   - streams completed response/tool blocks to the broker
 *   - fires a "turn complete" event on full settle (agent_settled)
 *   - injects prompts sent from the phone, with a visible indication
 *   - provides /mobileauth (QR pairing), /mobilestatus, /mobilestop
 *
 * Load during development with:  pi --extension ./extension/index.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import qrcode from "qrcode-terminal";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const STATE_DIR = path.join(PROJECT_ROOT, "state");
const BROKER_PATH = path.join(PROJECT_ROOT, "broker", "broker.mjs");

type Block = {
  id: string;
  role: string;
  kind: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  isError?: boolean;
  via?: string;
  images?: number;            // user messages: how many images were attached
  reqId?: string;             // phone slash commands
  result?: { ok?: boolean; pending?: boolean; text: string; choices?: { label: string; value: string }[] };
  tokensBefore?: number;      // compaction markers
  ts: number;
};

// Phone slash commands are saved in the session as custom entries (never sent to the
// model), so every device and later snapshots show them in the transcript.
const CMD_ENTRY = "pi-mobile-command";

function compactionToBlock(entry: any): Block {
  const ts = Date.parse(entry?.timestamp) || Date.now();
  return { id: entry?.id || nextId("compaction"), role: "compaction", kind: "compaction", text: entry?.summary || "", tokensBefore: entry?.tokensBefore, ts };
}

function commandEntryToBlock(entry: any): Block | undefined {
  const d = entry?.data;
  if (!d || typeof d.text !== "string") return undefined;
  return {
    id: `cmd-${d.reqId || entry.id}`, role: "command", kind: "command", reqId: d.reqId, text: d.text,
    ts: typeof d.ts === "number" ? d.ts : Date.parse(entry.timestamp) || Date.now(),
    result: { ok: !!d.ok, text: d.result || "", ...(Array.isArray(d.choices) ? { choices: d.choices } : {}) },
  };
}

type PhoneImage = { data: string; mimeType: string };
type PhoneFile = { path: string; name: string; size: number; mimeType?: string };

// Marker line the phone also recognizes, so it can show attached files as chips.
const ATTACH_MARKER = "📎 Attached from phone:";
function fmtBytes(n: number) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---- small state file helpers ------------------------------------------------------
function readJSON<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function loadConfig() {
  return {
    httpsPort: 47443,
    httpPort: 47080,
    loopbackPort: 47799,
    ...readJSON(path.join(STATE_DIR, "config.json"), {}),
  };
}
function readSecret(): string | undefined {
  try { return fs.readFileSync(path.join(STATE_DIR, "secret"), "utf8").trim(); } catch { return undefined; }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- message -> normalized blocks ---------------------------------------------------
function textFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

let blockSeq = 0;
function nextId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${(blockSeq++).toString(36)}`;
}

function messageToBlocks(message: any, baseId?: string): Block[] {
  const ts = typeof message?.timestamp === "number" ? message.timestamp : Date.now();
  const role = message?.role;
  const out: Block[] = [];
  const mkId = (i: number) => (baseId ? `${baseId}-${i}` : nextId(role || "b"));

  if (role === "user") {
    // Text parts only; images are reported as a count (the phone doesn't need the pixels back).
    const parts = Array.isArray(message.content) ? message.content : null;
    const text = parts ? parts.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("") : textFromContent(message.content);
    const images = parts ? parts.filter((c: any) => c?.type === "image").length : 0;
    out.push({ id: mkId(0), role, kind: "text", text, ...(images ? { images } : {}), ts });
  } else if (role === "assistant") {
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((c: any, i: number) => {
      if (c?.type === "text" && c.text?.trim()) {
        out.push({ id: mkId(i), role, kind: "text", text: c.text, ts });
      } else if (c?.type === "thinking" && (c.thinking || "").trim()) {
        out.push({ id: mkId(i), role, kind: "thinking", text: c.thinking, ts });
      } else if (c?.type === "toolCall") {
        out.push({ id: mkId(i), role, kind: "tool_call", toolName: c.name, toolInput: c.arguments, ts });
      }
    });
  } else if (role === "toolResult") {
    out.push({
      id: baseId || nextId("tr"),
      role: "toolResult",
      kind: "tool_result",
      toolName: message.toolName,
      toolResult: textFromContent(message.content),
      isError: !!message.isError,
      ts,
    });
  } else if (role === "bashExecution") {
    out.push({
      id: baseId || nextId("bash"),
      role: "toolResult",
      kind: "tool_result",
      toolName: "bash",
      toolInput: message.command,
      toolResult: message.output,
      isError: typeof message.exitCode === "number" && message.exitCode !== 0,
      ts,
    });
  } else if (role === "custom") {
    out.push({ id: baseId || nextId("custom"), role: "marker", kind: "text", text: textFromContent(message.content), ts });
  }
  return out;
}

// Does this model accept image input? (pi swaps images for a placeholder otherwise.)
function hasVision(model: any): boolean {
  return Array.isArray(model?.input) && model.input.includes("image");
}

// Context usage as pi's footer shows it ("6.0%/96k"): percent may be null right after
// compaction, before the next response reports usage.
function contextUsage(ctx: any): { percent: number | null; tokens: number | null; window: number } | undefined {
  try {
    const u = ctx?.getContextUsage?.();
    if (!u || !u.contextWindow) return undefined;
    return { percent: u.percent ?? null, tokens: u.tokens ?? null, window: u.contextWindow };
  } catch { return undefined; }
}

// ---- broker connection -------------------------------------------------------------
class BrokerLink {
  private ws: WebSocket | undefined;
  private connected = false;
  private closing = false;
  private pending = new Map<string, (msg: any) => void>();
  private lastSpawn = 0;
  session: any = null;

  onPrompt: (sessionId: string, text: string, deliverAs?: string, images?: PhoneImage[], files?: PhoneFile[]) => void = () => {};
  onStop: (sessionId: string) => void = () => {};
  onRequestSnapshot: (sessionId: string) => void = () => {};
  onCommand: (sessionId: string, text: string, reqId: string) => void = () => {};
  onGetCommands: (sessionId: string) => void = () => {};
  onPaired: (label: string) => void = () => {};

  async ensureBroker() {
    // Throttled rather than once-only, so a broker that was stopped or crashed comes back.
    // A duplicate spawn is harmless: it sees the port in use and exits.
    if (Date.now() - this.lastSpawn < 15000) return;
    this.lastSpawn = Date.now();
    try {
      const child = spawn(process.execPath, [BROKER_PATH], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: PROJECT_ROOT,
      });
      child.unref();
    } catch {
      /* best effort */
    }
  }

  connect() {
    if (this.closing) return;
    const cfg = loadConfig();
    const url = `ws://127.0.0.1:${cfg.loopbackPort}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      const secret = readSecret();
      if (!secret) {
        // broker not fully up yet; retry
        ws.close();
        return;
      }
      this.connected = true;
      ws.send(JSON.stringify({ t: "hello", role: "session", secret, session: this.session }));
    });

    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === "welcome") return;
      if (msg.t === "prompt") { this.onPrompt(msg.sessionId, msg.text, msg.deliverAs, msg.images, msg.files); return; }
      if (msg.t === "stop") { this.onStop(msg.sessionId); return; }
      if (msg.t === "request-snapshot") { this.onRequestSnapshot(msg.sessionId); return; }
      if (msg.t === "command") { this.onCommand(msg.sessionId, String(msg.text || ""), String(msg.reqId || "")); return; }
      if (msg.t === "get-commands") { this.onGetCommands(msg.sessionId); return; }
      if (msg.t === "paired") { this.onPaired(String(msg.label || "")); return; }
      if (msg.reqId && this.pending.has(msg.reqId)) {
        this.pending.get(msg.reqId)!(msg);
        this.pending.delete(msg.reqId);
      }
    });

    ws.on("close", () => {
      this.connected = false;
      this.ws = undefined;
      this.scheduleReconnect();
    });
    ws.on("error", () => { /* handled by close */ });
  }

  private reconnectTimer: NodeJS.Timeout | undefined;
  private scheduleReconnect() {
    if (this.closing || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      await this.ensureBroker();
      await delay(500);
      this.connect();
    }, 1200);
  }

  send(obj: any) {
    if (this.ws && this.connected && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  // request/response (for pairing + device admin)
  async request(obj: any, timeoutMs = 8000): Promise<any> {
    const reqId = nextId("req");
    return new Promise(async (resolve, reject) => {
      await this.ensureBroker();
      // Wait until connected (up to timeout).
      const start = Date.now();
      while (!this.connected && Date.now() - start < timeoutMs) {
        if (!this.ws) this.connect();
        await delay(250);
      }
      if (!this.connected) return reject(new Error("broker unavailable"));
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("broker timeout"));
      }, timeoutMs);
      this.pending.set(reqId, (msg) => { clearTimeout(timer); resolve(msg); });
      this.send({ ...obj, reqId });
    });
  }

  close() {
    this.closing = true;
    try { this.ws?.close(); } catch {}
  }
}

const link = new BrokerLink();

// Full-size, dismissible overlay that renders the pairing QR without the height
// clipping of the editor widget. Structurally matches pi's focusable-component
// contract (render/handleInput/invalidate/dispose + width) without importing the
// TUI package, so it resolves cleanly from this folder.
class QrOverlay {
  width: number;
  focused = false;
  private done: (v: null) => void;
  private tick: ReturnType<typeof setInterval> | undefined;
  private expiresAt: number;
  pairedLabel: string | undefined;
  private contentW: number;

  constructor(
    private qrLines: string[],
    private url: string,
    private fingerprint: string,
    expiresInSec: number,
    private theme: any,
    tui: any,
    done: (v: null) => void,
  ) {
    this.done = done;
    this.expiresAt = Date.now() + expiresInSec * 1000;
    const plain = [...qrLines, `url          ${url}`, "  3  Tap “open pi mobile” to finish", "pi mobile · pair a phone      valid 0:00"];
    // 56 fits the title plus the longest status ("expired · run /mobileauth again").
    this.contentW = Math.max(56, ...plain.map((l) => l.length));
    this.width = this.contentW + 4;
    // Live countdown; also lets the overlay show "paired" the moment the phone finishes.
    this.tick = setInterval(() => tui?.requestRender?.(), 1000);
  }

  paired(label: string) {
    this.pairedLabel = label || "phone";
    setTimeout(() => this.done(null), 1800);
  }

  // Pad on the *visible* text, then colour, so the box stays a solid rectangle
  // (the QR quiet zone must stay opaque to scan).
  private row(text: string, style?: (s: string) => string, rightText = "", rightStyle?: (s: string) => string) {
    if (rightText.length > this.contentW - text.length - 1) rightText = rightText.slice(0, Math.max(0, this.contentW - text.length - 2)) + "…";
    const gap = Math.max(rightText ? 1 : 0, this.contentW - text.length - rightText.length);
    const left = style ? style(text) : text;
    const right = rightText ? (rightStyle ? rightStyle(rightText) : rightText) : "";
    return "  " + left + " ".repeat(gap) + right + "  ";
  }

  render(_width: number): string[] {
    const th = this.theme;
    const fg = (c: string) => (t: string) => { try { return th.fg(c, t); } catch { return t; } };
    const bold = (t: string) => { try { return th.bold(t); } catch { return t; } };
    const left = Math.max(0, Math.round((this.expiresAt - Date.now()) / 1000));
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    const blank = " ".repeat(this.width);
    let status: string;
    let statusStyle: (t: string) => string;
    if (this.pairedLabel) { status = `✓ paired ${this.pairedLabel}`; statusStyle = fg("success"); }
    else if (left <= 0) { status = "expired · run /mobileauth again"; statusStyle = fg("error"); }
    else { status = `valid ${clock}`; statusStyle = left < 60 ? fg("warning") : fg("dim"); }
    const step = (n: string, text: string) => {
      const plain = `  ${n}  ${text}`;
      return "  " + "  " + fg("accent")(n) + "  " + text + " ".repeat(Math.max(0, this.contentW - plain.length)) + "  ";
    };
    return [
      blank,
      this.row("pi mobile · pair a phone", (t) => bold(fg("accent")(t)), status, statusStyle),
      blank,
      ...this.qrLines.map((l) => this.row(l)),
      blank,
      step("1", "Scan this with the phone's camera"),
      step("2", "Install the certificate the page offers"),
      step("3", "Tap “open pi mobile” to finish"),
      blank,
      this.row(`fingerprint  ${this.fingerprint || "-"}`, (t) => fg("dim")("fingerprint  ") + fg("mdHeading")(t.slice(13))),
      this.row(`url          ${this.url}`, (t) => fg("dim")("url          ") + fg("mdLink")(t.slice(13))),
      blank,
      this.row("esc / enter to close", fg("dim")),
      blank,
    ];
  }
  handleInput(data: string): void {
    if (data === "\x1b" || data === "\r" || data === "\n" || data === "q") this.done(null);
  }
  invalidate(): void {}
  dispose(): void { if (this.tick) clearInterval(this.tick); }
}

// ---- extension entry ---------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  let lastCtx: ExtensionContext | undefined;
  let currentSessionId: string | undefined;

  const buildSessionInfo = (ctx: ExtensionContext) => {
    const sm = ctx.sessionManager;
    return {
      id: sm.getSessionId(),
      name: sm.getSessionName?.() || undefined,
      cwd: ctx.cwd,
      pid: process.pid,
      sessionFile: sm.getSessionFile?.(),
      model: ctx.model?.id,
      thinkingLevel: ctx.thinkingLevel,
    };
  };

  // Mark user blocks that originated on the phone so the PWA can label them.
  const tagMobile = (blocks: Block[]): Block[] => {
    for (const b of blocks) if (b.role === "user" && mobilePrompts.has(norm(b.text || ""))) b.via = "mobile";
    return blocks;
  };

  const snapshot = (ctx: ExtensionContext): Block[] => {
    let entries: any[] = [];
    try { entries = ctx.sessionManager.getBranch(); } catch { entries = []; }
    const blocks: Block[] = [];
    for (const entry of entries) {
      if (entry?.type === "compaction") { blocks.push(compactionToBlock(entry)); continue; }
      if (entry?.type === "custom" && entry.customType === CMD_ENTRY) {
        const b = commandEntryToBlock(entry);
        if (b) blocks.push(b);
        continue;
      }
      if (entry?.type !== "message") continue;
      const role = entry.message?.role;
      if (role === "system") continue;
      for (const b of tagMobile(messageToBlocks(entry.message, entry.id))) blocks.push(b);
    }
    // Commands still running haven't been saved to the session yet.
    for (const b of liveCommands.values()) if (b.id && !blocks.some((x) => x.id === b.id)) blocks.push(b);
    blocks.sort((a, b) => a.ts - b.ts);
    return blocks;
  };

  const sendSnapshot = (ctx: ExtensionContext) => {
    link.send({
      t: "snapshot",
      sessionId: ctx.sessionManager.getSessionId(),
      blocks: snapshot(ctx),
      status: { working: !ctx.isIdle(), model: ctx.model?.id, name: ctx.sessionManager.getSessionName?.(), vision: hasVision(ctx.model), thinkingLevel: safeThinking(), context: contextUsage(ctx) },
    });
  };

  const emitBlocks = (sessionId: string, blocks: Block[]) => {
    for (const block of blocks) link.send({ t: "block", sessionId, block });
  };

  // ---- phone-prompt presentation ----
  // A phone prompt is a normal pi user message (same bubble, same history). We only
  // add a quiet "via mobile" footer inside that bubble at render time via a Markdown
  // transformer, so the model never sees it. Which prompts came from the phone is
  // persisted as invisible custom entries, so the footer survives a resume/reload.
  const MOBILE_ENTRY = "pi-mobile:prompt";
  const LEGACY_MOBILE_ENTRY = "mobile-companion:prompt"; // written by earlier versions
  const mobilePrompts = new Map<string, number>(); // normalized text -> sent-at ms
  // pi appends "[Image: original WxH, displayed at …]" when it resizes an image; ignore it when matching.
  const IMAGE_NOTE_RE = /\s*\[Image: original \d+x\d+, displayed at \d+x\d+\.[^\]]*\]/g;
  const norm = (s: string) => String(s || "").replace(IMAGE_NOTE_RE, "").trim();
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const loadMobilePrompts = (ctx: ExtensionContext) => {
    mobilePrompts.clear();
    try {
      for (const e of ctx.sessionManager.getEntries() as any[]) {
        if (e?.type === "custom" && (e.customType === MOBILE_ENTRY || e.customType === LEGACY_MOBILE_ENTRY) && e.data?.text) {
          mobilePrompts.set(norm(e.data.text), e.data.ts || Date.parse(e.timestamp) || Date.now());
        }
      }
    } catch {}
  };

  if (typeof (pi as any).registerMarkdownTransformer === "function") {
    pi.registerMarkdownTransformer((markdown, mctx) => {
      if (mctx.messageType !== "user") return markdown;
      const ts = mobilePrompts.get(norm(markdown));
      return ts === undefined ? markdown : `${markdown}\n\n*↳ via mobile · ${clock(ts)}*`;
    });
  }

  // Footer status: a small accent dot + dim text, in the active theme's colors.
  const setPhoneStatus = (ctx: ExtensionContext | undefined, label: string) => {
    if (!ctx?.hasUI) return;
    const th = ctx.ui.theme;
    ctx.ui.setStatus("pi-mobile", `${th.fg("accent", "●")} ${th.fg("dim", label)}`);
  };

  // Broker -> inject a prompt from the phone into this session.
  // deliverAs lets the phone steer (interrupt) or queue when the agent is busy.
  link.onPrompt = (sessionId, rawText, deliverAs, images = [], files = []) => {
    if (sessionId !== currentSessionId) return;
    if (!rawText && !images.length && !files.length) return;
    const ctx = lastCtx;
    const mode = deliverAs === "steer" ? "steer" : "followUp";
    const sentAt = Date.now();
    // Files were saved on this PC by the broker; tell the agent where, so its tools can read them.
    let text = rawText || "";
    if (files.length) {
      const lines = files.map((f) => `- ${f.name}${f.size ? ` (${fmtBytes(f.size)})` : ""}: ${f.path}`);
      text = `${text}${text ? "\n\n" : ""}${ATTACH_MARKER}\n${lines.join("\n")}`;
    }
    // Images go to the model as real image content alongside the text.
    const content: any = images.length
      ? [{ type: "text", text }, ...images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }))]
      : text;
    // Record origin *before* sending so the bubble renders with its footer from the start.
    mobilePrompts.set(norm(text), sentAt);
    try { pi.appendEntry(MOBILE_ENTRY, { text, ts: sentAt }); } catch {}
    try {
      const idle = ctx ? ctx.isIdle() : true;
      if (idle) pi.sendUserMessage(content);
      else pi.sendUserMessage(content, { deliverAs: mode });
    } catch {
      try { pi.sendUserMessage(content, { deliverAs: "followUp" }); } catch {}
    }
    // No toast: the prompt appears as a regular user message (with its "via mobile"
    // footer), or in pi's own queue while busy. The footer status just notes activity.
    // (The phone shows its own optimistic echo; the real user message streams back
    // via message_end, so we deliberately do NOT broadcast an extra marker block.)
    const how = ctx && !ctx.isIdle() ? (mode === "steer" ? "steered from phone" : "queued from phone") : "from phone";
    setPhoneStatus(ctx, `${how} · ${clock(sentAt)}`);
  };

  // Broker -> stop/abort the current turn in this session.
  link.onStop = (sessionId) => {
    if (sessionId !== currentSessionId) return;
    try { lastCtx?.abort(); } catch {}
    setPhoneStatus(lastCtx, `stopped from phone · ${clock(Date.now())}`);
  };

  // ---- slash commands from the phone ----
  // Extension commands, skills and prompt templates run natively via sendUserMessage
  // (expandPromptTemplates). pi's built-ins live in the interactive UI, so the useful
  // ones are re-implemented here with the extension API; selector-only ones are refused.
  const EXEC_CMD = "pi-mobile-exec"; // hidden helper: gives us a command context for /new and /reload
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const PHONE_BUILTINS: { name: string; description: string; args?: string }[] = [
    { name: "compact", description: "Compact the session context", args: "[instructions]" },
    { name: "model", description: "Switch model", args: "[provider/model]" },
    { name: "thinking", description: "Set thinking level", args: "[level]" },
    { name: "name", description: "Set session display name", args: "<name>" },
    { name: "session", description: "Show session info and stats" },
    { name: "notify", description: "Push turn completions even when the app is closed", args: "[on|off]" },
    { name: "new", description: "Start a new session" },
    { name: "reload", description: "Reload extensions, skills, prompts and context files" },
  ];
  // /notify: an open Pi Mobile page is always notified when a turn finishes. Web Push,
  // which also reaches a phone whose app is frozen or closed, is opt-in per session.
  const showNotify = (ctx: ExtensionContext | undefined, on: boolean) => {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus("pi-mobile-notify", on ? ctx.ui.theme.fg("accent", "🔔 push") : undefined);
  };
  const setNotify = async (ctx: ExtensionContext | undefined, sessionId: string, arg: string): Promise<string> => {
    const a = arg.trim().toLowerCase();
    if (a && a !== "on" && a !== "off") throw new Error("Usage: /notify [on|off]");
    const res = await link.request({ t: "set-notify", sessionId, ...(a ? { on: a === "on" } : {}) }, 8000);
    showNotify(ctx, !!res.on);
    if (!res.on) return "Push notifications off for this session. An open Pi Mobile app still notifies.";
    if (!res.webPush) return "Push is on for this session, but Web Push is turned off in state/config.json.";
    if (!res.devices) return "Push is on for this session, but no phone has registered for push yet. Open Pi Mobile and allow notifications.";
    return `Push notifications on for this session, even when Pi Mobile is closed (${res.devices} phone${res.devices === 1 ? "" : "s"}).`;
  };
  const TERMINAL_ONLY = new Set(["settings", "tree", "scoped-models", "export", "import", "share", "bug", "copy",
    "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "resume", "quit"]);
  const liveCommands = new Map<string, Block>(); // reqId -> command block not yet saved
  let pendingExec: ((cctx: ExtensionCommandContext, action: string) => Promise<void>) | undefined;

  function safeThinking(): string | undefined {
    try { return pi.getThinkingLevel(); } catch { return lastCtx?.thinkingLevel; }
  }
  const listCommands = () => {
    const builtins = PHONE_BUILTINS.map((c) => ({ ...c, source: "builtin" }));
    let others: any[] = [];
    try {
      others = pi.getCommands()
        .filter((c) => c.name !== EXEC_CMD && !PHONE_BUILTINS.some((b) => b.name === c.name))
        .map((c) => ({ name: c.name, description: c.description || "", source: String(c.source || "extension") }));
    } catch {}
    return [...builtins, ...others];
  };
  link.onGetCommands = (sessionId) => {
    if (sessionId !== currentSessionId) return;
    link.send({ t: "commands", sessionId, commands: listCommands() });
  };

  link.onCommand = (sessionId, text, reqId) => {
    if (sessionId !== currentSessionId) return;
    const ctx = lastCtx;
    const m = text.trim().match(/^\/(\S+)\s*([\s\S]*)$/);
    const cmd: Block = { id: `cmd-${reqId}`, role: "command", kind: "command", reqId, text: text.trim(), ts: Date.now(), result: { pending: true, text: "running…" } };
    liveCommands.set(reqId, cmd);
    link.send({ t: "block", sessionId, block: cmd });
    const reply = (ok: boolean, msg: string, extra: Record<string, unknown> = {}) => {
      const choices = Array.isArray(extra.choices) ? (extra.choices as { label: string; value: string }[]) : undefined;
      cmd.result = { ok, pending: !!extra.pending, text: msg, ...(choices ? { choices } : {}) };
      link.send({ t: "command-result", sessionId, reqId, command: m?.[1] || "", ok, text: msg, ...extra });
      // Save the first final result into the session history.
      if (!extra.pending && liveCommands.delete(reqId)) {
        try { pi.appendEntry(CMD_ENTRY, { reqId, text: cmd.text, ts: cmd.ts, ok, result: msg, ...(choices ? { choices } : {}) }); } catch {}
      }
    };
    if (!m || !ctx) { reply(false, "Not a command."); return; }
    const name = m[1].toLowerCase();
    const args = m[2].trim();
    setPhoneStatus(ctx, `/${name} from phone · ${clock(Date.now())}`);
    const fail = (e: any) => reply(false, String(e?.message || e));

    try {
      switch (name) {
        case "compact": {
          if (!ctx.isIdle()) { reply(false, "pi is busy. Stop the turn or wait, then compact."); return; }
          reply(true, "Compacting…", { pending: true });
          ctx.compact({
            customInstructions: args || undefined,
            onComplete: (r) => {
              const after = r.estimatedTokensAfter ? ` → ~${Math.round(r.estimatedTokensAfter / 1000)}k` : "";
              reply(true, `Context compacted (${Math.round(r.tokensBefore / 1000)}k${after} tokens).`);
              sendSnapshot(lastCtx || ctx);
            },
            onError: fail,
          });
          return;
        }
        case "model": {
          const models = ctx.modelRegistry.getAvailable();
          const cur = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
          if (!args) {
            reply(true, `Current model: ${cur || "none"}`, {
              choices: models.slice(0, 60).map((mm) => {
                const id = `${mm.provider}/${mm.id}`;
                return { label: id + (id === cur ? "  ✓" : ""), value: `/model ${id}` };
              }),
            });
            return;
          }
          const q = args.toLowerCase();
          const hit = models.find((mm) => `${mm.provider}/${mm.id}`.toLowerCase() === q)
            || models.find((mm) => mm.id.toLowerCase() === q)
            || models.find((mm) => `${mm.provider}/${mm.id} ${mm.name || ""}`.toLowerCase().includes(q));
          if (!hit) { reply(false, `No available model matches "${args}".`); return; }
          pi.setModel(hit).then((ok) => {
            if (!ok) { reply(false, `No credentials configured for ${hit.provider}.`); return; }
            reply(true, `Model set to ${hit.provider}/${hit.id}${hasVision(hit) ? "" : " (text only)"}.`);
            link.send({ t: "status", sessionId, status: { model: hit.id, vision: hasVision(hit), thinkingLevel: safeThinking() } });
          }, fail);
          return;
        }
        case "thinking": {
          const curLevel = safeThinking() || "";
          if (!args) {
            reply(true, `Thinking level: ${curLevel || "unknown"}`, {
              choices: THINKING_LEVELS.map((l) => ({ label: l + (l === curLevel ? "  ✓" : ""), value: `/thinking ${l}` })),
            });
            return;
          }
          if (!THINKING_LEVELS.includes(args.toLowerCase())) { reply(false, `Levels: ${THINKING_LEVELS.join(", ")}`); return; }
          pi.setThinkingLevel(args.toLowerCase() as any);
          const now = safeThinking();
          reply(true, `Thinking level: ${now}${now !== args.toLowerCase() ? " (clamped to what this model supports)" : ""}.`);
          link.send({ t: "status", sessionId, status: { thinkingLevel: now } });
          return;
        }
        case "name": {
          if (!args) { reply(true, `Session name: ${pi.getSessionName() || "(none)"}`); return; }
          pi.setSessionName(args);
          reply(true, `Session renamed to "${args}".`);
          return;
        }
        case "session": {
          const u = ctx.getContextUsage() as any;
          const lines = [
            `model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"} · thinking: ${safeThinking() || "-"}`,
            u ? `context: ${u.tokens != null ? Math.round(u.tokens / 1000) + "k" : "?"} / ${u.contextWindow ? Math.round(u.contextWindow / 1000) + "k" : "?"}${u.percent != null ? ` (${Math.round(u.percent)}%)` : ""}` : "context: unknown",
            `messages: ${ctx.sessionManager.getEntries().filter((e: any) => e.type === "message").length}`,
            `file: ${ctx.sessionManager.getSessionFile?.() || "(in memory)"}`,
          ];
          reply(true, lines.join("\n"));
          return;
        }
        case "notify": {
          setNotify(ctx, sessionId, args).then((t) => reply(true, t), fail);
          return;
        }
        case "new":
        case "reload": {
          if (name === "new" && !ctx.isIdle()) { reply(false, "pi is busy. Stop the turn first."); return; }
          pendingExec = async (cctx, action) => {
            if (action === "new") {
              reply(true, "Starting a new session…", { follow: true });
              const r = await cctx.newSession();
              if (r.cancelled) reply(false, "New session was cancelled.");
            } else {
              // The extension runtime restarts during reload, so report first.
              reply(true, "Reloading extensions, skills, prompts and context files…");
              await cctx.reload();
            }
          };
          pi.sendUserMessage(`/${EXEC_CMD} ${name}`, { expandPromptTemplates: true });
          return;
        }
      }
      if (TERMINAL_ONLY.has(name)) { reply(false, `/${name} needs the terminal UI, so it isn't available from the phone.`); return; }
      if (name === EXEC_CMD) { reply(false, "Not available."); return; }
      // Extension commands, skills (/skill:x) and prompt templates: let pi handle them natively.
      const known = listCommands().some((c) => c.name.toLowerCase() === name) || name.startsWith("skill:");
      if (!known) { reply(false, `Unknown command /${name}.`); return; }
      if (ctx.isIdle()) pi.sendUserMessage(text.trim(), { expandPromptTemplates: true });
      else pi.sendUserMessage(text.trim(), { expandPromptTemplates: true, deliverAs: "followUp" });
      reply(true, `Ran /${name}.`);
    } catch (e) {
      fail(e);
    }
  };

  link.onRequestSnapshot = (sessionId) => {
    if (sessionId === currentSessionId && lastCtx) sendSnapshot(lastCtx);
  };

  // ---- lifecycle ----
  pi.on("session_start", async (_e, ctx) => {
    lastCtx = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    loadMobilePrompts(ctx);
    link.session = buildSessionInfo(ctx);
    await link.ensureBroker();
    await delay(400);
    link.connect();
    // Give the socket a moment, then register + snapshot.
    setTimeout(() => {
      link.session = buildSessionInfo(ctx);
      link.send({ t: "hello", role: "session", secret: readSecret(), session: link.session });
      sendSnapshot(ctx);
      const sid = ctx.sessionManager.getSessionId();
      link.request({ t: "get-notify", sessionId: sid }, 8000).then((r) => showNotify(ctx, !!r.on), () => {});
    }, 1500);
  });

  pi.on("session_info_changed", (e, ctx) => {
    lastCtx = ctx;
    link.session = buildSessionInfo(ctx);
    link.send({ t: "status", sessionId: ctx.sessionManager.getSessionId(), status: { name: e.name, model: ctx.model?.id } });
  });

  pi.on("agent_start", (_e, ctx) => {
    lastCtx = ctx;
    link.send({ t: "status", sessionId: ctx.sessionManager.getSessionId(), status: { working: true, model: ctx.model?.id, vision: hasVision(ctx.model) } });
  });

  pi.on("message_end", (e, ctx) => {
    lastCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    // Skip system messages; stream everything else as completed blocks.
    if ((e.message as any)?.role === "system") return;
    emitBlocks(sessionId, tagMobile(messageToBlocks(e.message)));
    if ((e.message as any)?.role === "assistant") link.send({ t: "status", sessionId, status: { context: contextUsage(ctx) } });
  });

  pi.on("session_compact", (e, ctx) => {
    // Covers /compact typed in the terminal and automatic compaction, not just the phone.
    if (e?.compactionEntry) link.send({ t: "block", sessionId: ctx.sessionManager.getSessionId(), block: compactionToBlock(e.compactionEntry) });
    link.send({ t: "status", sessionId: ctx.sessionManager.getSessionId(), status: { context: contextUsage(ctx) } });
  });

  pi.on("model_select", (e, ctx) => {
    link.send({ t: "status", sessionId: ctx.sessionManager.getSessionId(), status: { model: e.model?.id, vision: hasVision(e.model), context: contextUsage(ctx) } });
  });

  // Full turn completion — the notification trigger.
  pi.on("agent_settled", (e, ctx) => {
    lastCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    const name = ctx.sessionManager.getSessionName?.() || ctx.cwd.split(/[\\/]/).pop() || "pi";
    const body = lastAssistantSummary(ctx);
    link.send({
      t: "settled",
      sessionId,
      aborted: !!e.aborted,
      title: e.aborted ? `⏹ ${name} stopped` : `✅ ${name} finished`,
      body,
    });
    link.send({ t: "status", sessionId, status: { working: false, context: contextUsage(ctx) } });
  });

  pi.on("session_shutdown", (_e, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    link.send({ t: "bye", sessionId });
  });

  const lastAssistantSummary = (ctx: ExtensionContext): string => {
    try {
      const entries = ctx.sessionManager.getBranch();
      for (let i = entries.length - 1; i >= 0; i--) {
        const m = (entries[i] as any)?.message;
        if (m?.role === "assistant") {
          const t = textFromContent(m.content).trim();
          if (t) return t.slice(0, 140);
        }
      }
    } catch {}
    return "Response complete.";
  };

  // ---- commands ----
  pi.registerCommand("mobileauth", {
    description: "Pair a phone with Pi Mobile (shows a QR code)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.notify("Starting Pi Mobile broker…", "info");
      let res: any;
      try {
        res = await link.request({ t: "create-pairing" }, 12000);
      } catch (err: any) {
        ctx.ui.notify(`Could not reach broker: ${err?.message || err}`, "error");
        return;
      }
      const hostOptions: { name: string; address: string }[] =
        res.hostOptions?.length
          ? res.hostOptions
          : (res.hosts || (res.host ? [res.host] : [])).map((a: string) => ({ name: "", address: a }));
      if (!hostOptions.length) {
        ctx.ui.notify("No LAN IP found. Connect this PC to the same network as the phone.", "error");
        return;
      }
      let host = hostOptions[0].address;
      if (hostOptions.length > 1) {
        const labelFor = (o: { name: string; address: string }) =>
          o.name ? `${o.name} — ${o.address}` : o.address;
        const labels = hostOptions.map(labelFor);
        const chosen = await ctx.ui.select("Which adapter can the phone reach?", labels);
        const picked = hostOptions.find((o) => labelFor(o) === chosen);
        if (picked) host = picked.address;
      }
      const bootstrapUrl = `http://${host}:${res.httpPort}/p#${res.code}`;
      const qr = await new Promise<string>((resolve) =>
        qrcode.generate(bootstrapUrl, { small: true }, resolve)
      );
      const qrLines = qr.split("\n").filter((l) => l.trim().length > 0);
      const info = [
        "Scan with your phone's camera, then:",
        "  1. Install the CA certificate the page offers",
        "  2. Tap 'Open secure app' to finish pairing",
      ];

      // Preferred: a full-size overlay (not height-clipped like the editor widget).
      if (ctx.mode === "tui" && ctx.hasUI) {
        try {
          let overlay: QrOverlay | undefined;
          link.onPaired = (label) => overlay?.paired(label);
          await ctx.ui.custom<null>(
            (tui, theme, _kb, done) =>
              (overlay = new QrOverlay(qrLines, bootstrapUrl, res.caFingerprint || "", res.expiresInSec || 300, theme, tui, done)),
            { overlay: true }
          );
          link.onPaired = () => {};
          if (overlay?.pairedLabel) ctx.ui.notify(`Paired ${overlay.pairedLabel} with Pi Mobile.`, "info");
          return;
        } catch {
          /* fall through to widget fallback */
        }
      }

      // Fallback (RPC / no overlay support): widget + notify.
      ctx.ui.setWidget("mobile-qr", [
        "📱 Pi Mobile — scan to pair (valid 5 min):",
        "",
        ...qrLines,
        "",
        `URL: ${bootstrapUrl}`,
        ...info,
        "Run /mobileqr to hide this.",
      ]);
      setTimeout(() => ctx.ui.setWidget("mobile-qr", undefined), (res.expiresInSec || 300) * 1000);
    },
  });

  pi.registerCommand("mobilestatus", {
    description: "Show Pi Mobile paired devices and broker status",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      try {
        const res = await link.request({ t: "list-devices" }, 8000);
        const devices = res.devices || [];
        if (!devices.length) {
          ctx.ui.notify("No paired devices. Run /mobileauth to pair your phone.", "info");
          return;
        }
        const labels = devices.map(
          (d: any) => `${d.label} (${d.id})  last seen ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "never"}`
        );
        const REVOKE_ALL = `Revoke all (${devices.length})`;
        const pick = await ctx.ui.select("Paired devices — select to revoke (Esc to close):", [...labels, REVOKE_ALL, "Close"]);
        if (pick === REVOKE_ALL) {
          if (await ctx.ui.confirm("Revoke all devices?", `Every paired phone (${devices.length}) will need to pair again with /mobileauth.`)) {
            const r = await link.request({ t: "revoke-all-devices" }, 8000);
            ctx.ui.notify(`Revoked ${r.count ?? devices.length} device${(r.count ?? devices.length) === 1 ? "" : "s"}.`, "info");
          }
        } else if (pick && pick !== "Close") {
          const idx = labels.indexOf(pick);
          const dev = devices[idx];
          if (dev && (await ctx.ui.confirm("Revoke device?", dev.label))) {
            await link.request({ t: "revoke-device", deviceId: dev.id }, 8000);
            ctx.ui.notify(`Revoked ${dev.label}.`, "info");
          }
        }
      } catch (err: any) {
        ctx.ui.notify(`Broker not reachable: ${err?.message || err}`, "error");
      }
    },
  });

  pi.registerCommand(EXEC_CMD, {
    description: "Internal: runs /new and /reload requested from Pi Mobile",
    handler: async (args, cctx: ExtensionCommandContext) => {
      const run = pendingExec;
      pendingExec = undefined;
      if (!run) { cctx.ui.notify("Nothing to run (this command is used by Pi Mobile).", "info"); return; }
      try { await run(cctx, args.trim()); } catch (e: any) { cctx.ui.notify(`Pi Mobile: ${e?.message || e}`, "error"); }
    },
  });

  pi.registerCommand("notify", {
    description: "Pi Mobile: push turn completions for this session even when the app is closed [on|off]",
    handler: async (args, ctx: ExtensionCommandContext) => {
      try {
        ctx.ui.notify(await setNotify(ctx, ctx.sessionManager.getSessionId(), args), "info");
      } catch (err: any) {
        ctx.ui.notify(`Pi Mobile: ${err?.message || err}`, "error");
      }
    },
  });

  pi.registerCommand("mobileqr", {
    description: "Hide the Pi Mobile pairing QR widget",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.setWidget("mobile-qr", undefined);
    },
  });
}
