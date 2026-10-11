// Pi Mobile — PWA client
"use strict";

const TOKEN_KEY = "pi-mobile-token";
const NOTIF_DISMISS_KEY = "pi-mobile-notif-dismissed";
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
// Phones: Enter inserts a newline (send with the button). Keyboards: Enter sends.
const IS_TOUCH = matchMedia("(pointer: coarse)").matches;

const state = {
  token: store.get(TOKEN_KEY),
  ws: null,
  connected: false,
  sessions: new Map(),      // id -> meta
  blocks: new Map(),        // sessionId -> [blocks]
  current: null,            // open sessionId
  statusById: new Map(),
  pending: [],              // optimistic echoes awaiting their authoritative copy
  drafts: new Map(),        // sessionId -> unsent text
  commands: new Map(),      // sessionId -> [{ name, description, args?, source }]
  follow: null,             // after /new: { pid, oldId, until } -> open the replacement session
  attaches: new Map(),      // sessionId -> [{ id, file, kind: "image"|"file", url }] not yet sent
  deliverMode: "steer",     // how a prompt is delivered while the agent is working
  stick: true,              // transcript follows new output while scrolled to the bottom
  unseen: 0,                // blocks that arrived while scrolled up
  pendingOpen: null,        // session to open once the session list arrives (notification tap)
  reconnectTimer: null,
  pushKey: null,            // broker's VAPID key; null when the broker has Web Push off
  bannerTimer: null,
  backoff: 1000,
};

const normText = (s) => String(s == null ? "" : s).trim();
const isUserish = (b) => b && (b.role === "user" || b.role === "marker" || b.via === "mobile");
// Returns true if this incoming block matches (and consumes) a recent optimistic echo.
function consumePending(sessionId, text) {
  const key = normText(text);
  const now = Date.now();
  const i = state.pending.findIndex(
    (p) => p.sessionId === sessionId && p.text === key && now - p.ts < 300000
  );
  if (i >= 0) { state.pending.splice(i, 1); return true; }
  return false;
}

// ---------- viewport / keyboard ----------
// Pin the app shell to the visible viewport so the on-screen keyboard shrinks the
// transcript instead of pushing the top bar off-screen or covering the composer.
function syncViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  const top = vv ? vv.offsetTop : 0;
  const root = document.documentElement.style;
  root.setProperty("--app-h", h + "px");
  root.setProperty("--app-top", top + "px");
  if (state.current && state.stick) scrollToBottom();
}

// ---------- view switching ----------
function show(view) {
  for (const v of ["pairView", "listView", "chatView"]) $(v).hidden = (v !== view);
  $("backBtn").hidden = (view !== "chatView");
  document.body.classList.toggle("pairing", view === "pairView"); // the pairing screen has its own header
  updateBanner();
}
function toast(msg, ms = 2400) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- pairing ----------
function pairState(kind, msg) {
  $("pairBusy").hidden = kind !== "busy";
  $("pairFail").hidden = kind !== "fail";
  if (kind === "fail") $("pairFailMsg").textContent = msg;
}
async function tryPair(code) {
  pairState("busy");
  show("pairView");
  try {
    const res = await fetch("/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, label: navigator.userAgent.slice(0, 80) }),
    });
    if (res.status === 401) throw new Error("That QR code has expired or was already used. Run /mobileauth on your PC for a fresh one.");
    if (!res.ok) throw new Error(`Your PC answered with an error (${res.status}). Try /mobileauth again.`);
    const data = await res.json();
    state.token = data.token;
    store.set(TOKEN_KEY, data.token);
    pairState(null);
    toast("Paired ✓");
    return true;
  } catch (e) {
    const msg = e instanceof TypeError ? "Couldn't reach your PC. Check the phone is on the same Wi-Fi, then scan again." : e.message;
    pairState("fail", msg);
    return false;
  }
}

// ---------- websocket ----------
function connect() {
  if (!state.token) { show("pairView"); return; }
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
  const url = `wss://${location.host}/ws?token=${encodeURIComponent(state.token)}`;
  let ws;
  try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
  state.ws = ws;

  ws.onopen = () => {
    setConn(true);
    state.backoff = 1000;
    ws.send(JSON.stringify({ t: "subscribe" }));
    sendVisibility();
    if (state.current) ws.send(JSON.stringify({ t: "get-snapshot", sessionId: state.current }));
  };
  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    setConn(false);
    if (ev.code === 1008 || ev.code === 4401) { // auth rejected
      store.del(TOKEN_KEY); state.token = null; show("pairView"); return;
    }
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };
}
function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    state.backoff = Math.min(state.backoff * 1.6, 15000);
    connect();
  }, state.backoff);
}
function reconnectNow() {
  clearTimeout(state.reconnectTimer); state.reconnectTimer = null;
  state.backoff = 1000;
  connect();
}
function setConn(on) {
  state.connected = on;
  const d = $("connDot");
  d.className = "dot " + (on ? "on" : "off");
  d.title = on ? "Connected" : "Disconnected";
  updateBanner();
  updateComposer();
}
// Show "Reconnecting…" only if the outage lasts more than a moment (no flash on boot).
function updateBanner() {
  const b = $("connBanner");
  const relevant = !!state.token && $("pairView").hidden;
  if (state.connected || !relevant) {
    clearTimeout(state.bannerTimer); state.bannerTimer = null;
    b.hidden = true;
    return;
  }
  if (b.hidden && !state.bannerTimer) {
    state.bannerTimer = setTimeout(() => {
      state.bannerTimer = null;
      if (!state.connected) b.hidden = false;
    }, 1500);
  }
}
function wsSend(obj) {
  if (state.ws && state.ws.readyState === 1) { state.ws.send(JSON.stringify(obj)); return true; }
  return false;
}

// ---------- message handling ----------
function handle(msg) {
  switch (msg.t) {
    case "sessions":
      state.sessions = new Map(msg.sessions.map((s) => [s.id, s]));
      for (const s of msg.sessions) {
        state.statusById.set(s.id, { ...state.statusById.get(s.id), working: s.working, model: s.model, ...(s.vision != null ? { vision: s.vision } : {}), ...(s.context ? { context: s.context } : {}) });
      }
      if (state.follow) {
        const f = state.follow;
        const next = Date.now() < f.until && [...state.sessions.values()].find((s) => s.pid === f.pid && s.id !== f.oldId);
        if (next) { state.follow = null; toast("Switched to the new session"); openChat(next.id, true); break; }
        if (Date.now() >= f.until) state.follow = null;
      }
      if (state.pendingOpen && state.sessions.has(state.pendingOpen)) {
        const id = state.pendingOpen; state.pendingOpen = null;
        openChat(id);
      } else if (state.current) updateChatHeader();
      else renderList();
      break;
    case "snapshot": {
      // Command rows are part of the snapshot; keep only local ones it doesn't know yet
      // (sent a moment ago, or from an older extension that doesn't record them).
      const snap = msg.blocks || [];
      const known = new Set(snap.filter((b) => b.kind === "command").map((b) => b.reqId));
      const keepCmds = (state.blocks.get(msg.sessionId) || []).filter((b) => b.kind === "command" && !known.has(b.reqId) && Date.now() - b.ts < 15 * 60000);
      state.blocks.set(msg.sessionId, [...snap, ...keepCmds]);
      // The snapshot is authoritative: any optimistic echo it contains is already in it,
      // so stop waiting to dedupe (otherwise the next real block would be swallowed).
      state.pending = state.pending.filter((p) => p.sessionId !== msg.sessionId);
      if (msg.status) state.statusById.set(msg.sessionId, { ...state.statusById.get(msg.sessionId), ...msg.status });
      if (state.current === msg.sessionId) { renderTranscript(); updateChatHeader(); }
      break;
    }
    case "block": {
      // A command row we already show (we sent it): just refresh its result.
      if (msg.block && msg.block.kind === "command") {
        const mine = (state.blocks.get(msg.sessionId) || []).find((x) => x.kind === "command" && x.reqId === msg.block.reqId);
        if (mine) { onCommandResult({ sessionId: msg.sessionId, reqId: mine.reqId, ...(msg.block.result || {}) }); break; }
      }
      // Drop the authoritative copy of a prompt we already echoed optimistically.
      if (isUserish(msg.block) && consumePending(msg.sessionId, stripImageNotes(splitAttach(msg.block.text).text))) break;
      const arr = state.blocks.get(msg.sessionId) || [];
      arr.push(msg.block);
      state.blocks.set(msg.sessionId, arr);
      if (state.current === msg.sessionId) appendBlock(msg.block);
      break;
    }
    case "status":
      state.statusById.set(msg.sessionId, { ...state.statusById.get(msg.sessionId), ...msg.status });
      if (state.current === msg.sessionId) updateChatHeader();
      else renderList();
      break;
    case "settled":
      onSettled(msg);
      break;
    case "push-key":
      state.pushKey = msg.key;
      syncPush();
      break;
    case "session-removed":
      state.sessions.delete(msg.sessionId);
      state.blocks.delete(msg.sessionId);
      if (state.current === msg.sessionId && state.follow && state.follow.oldId === msg.sessionId) {
        setTimeout(() => { if (state.follow && state.current === msg.sessionId) { state.follow = null; goToList(); } }, 15000);
      } else if (state.current === msg.sessionId) { toast("Session closed on PC"); goToList(); }
      else renderList();
      break;
    case "prompt-echo":
      if (!msg.ok) markFailed(msg.sessionId, msg.text);
      break;
    case "commands":
      state.commands.set(msg.sessionId, Array.isArray(msg.commands) ? msg.commands : []);
      if (state.current === msg.sessionId) updateCmdMenu();
      break;
    case "command-result":
      onCommandResult(msg);
      break;
    case "stop-ack":
      $("stopBtn").disabled = false;
      toast(msg.ok ? "Stop sent" : "Could not stop: session offline");
      break;
  }
}

function onSettled(msg) {
  const meta = state.sessions.get(msg.sessionId);
  const st = state.statusById.get(msg.sessionId);
  if (st) st.working = false;
  if (state.current === msg.sessionId) updateChatHeader(); else renderList();
  if (msg.aborted) return; // notify only on real completion
  // Already looking at this chat: a notification would just be noise.
  if (!document.hidden && document.hasFocus() && state.current === msg.sessionId) {
    try { navigator.vibrate && navigator.vibrate(60); } catch {}
    return;
  }
  const title = msg.title || "Pi turn complete";
  const body = msg.body || (meta ? meta.name : "");
  // System notifications come only from Web Push, for sessions opted in with /notify.
  // The broker pushes whenever this page isn't in use (hidden, or visible in split
  // screen without focus). While it is in use, show our own banner instead.
  const inUse = !document.hidden && document.hasFocus();
  if (inUse && meta && meta.notify) {
    showHeadsUp(title, body, msg.sessionId);
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {}
  }
  // LAN notifications (shown by this page from the WebSocket) are disabled for now.
  // They stop once Chrome freezes the page, so Web Push replaced them.
  // if (notifPermission() === "granted" && !inUse) {
  //   if (!msg.push) notify(title, body, msg.sessionId); // otherwise the push shows it
  //   return;
  // }
  // if (!document.hidden) {
  //   showHeadsUp(title, body, msg.sessionId);
  //   try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {}
  //   return;
  // }
  // if (!msg.push) notify(title, body, msg.sessionId);
}

// ---------- in-app heads-up banner ----------
function showHeadsUp(title, body, sessionId) {
  const el = $("headsUp");
  $("huTitle").textContent = title;
  $("huBody").textContent = body;
  el.dataset.sessionId = sessionId || "";
  el.classList.remove("leaving");
  el.hidden = true; void el.offsetWidth; el.hidden = false; // restart the slide-in
  clearTimeout(showHeadsUp._t);
  showHeadsUp._t = setTimeout(hideHeadsUp, 6000);
}
function hideHeadsUp() {
  const el = $("headsUp");
  if (el.hidden || el.classList.contains("leaving")) return;
  clearTimeout(showHeadsUp._t);
  el.classList.add("leaving");
  setTimeout(() => { if (el.classList.contains("leaving")) { el.hidden = true; el.classList.remove("leaving"); } }, 220);
}
function wireHeadsUp() {
  const el = $("headsUp");
  let startY = null, moved = false;
  el.addEventListener("pointerdown", (e) => { startY = e.clientY; moved = false; });
  el.addEventListener("pointermove", (e) => {
    if (startY == null) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 8) moved = true;
    el.style.transform = dy < 0 ? `translateY(${dy}px)` : "";
    if (dy < -40) { startY = null; el.style.transform = ""; hideHeadsUp(); } // swipe up to dismiss
  });
  const end = () => { startY = null; el.style.transform = ""; };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("click", () => {
    if (moved) return;
    const id = el.dataset.sessionId;
    hideHeadsUp();
    if (id && state.sessions.has(id) && state.current !== id) openChat(id);
  });
}

// ---------- notifications ----------
// LAN notifications are disabled for now (see onSettled); the service worker shows
// Web Push notifications instead.
// async function notify(title, body, sessionId) {
//   if (!("Notification" in window) || Notification.permission !== "granted") {
//     if (!document.hidden) toast("✓ " + title);
//     return;
//   }
//   try {
//     const reg = await navigator.serviceWorker.getRegistration();
//     const opts = {
//       body,
//       tag: sessionId,
//       renotify: true,          // re-alert (sound/vibrate) on repeat instead of silently replacing
//       silent: false,
//       vibrate: [300, 150, 300],
//       requireInteraction: false,
//       data: { sessionId },
//       icon: "/icons/icon-192.png",
//       badge: "/icons/badge-96.png",    // monochrome status-bar icon
//     };
//     if (reg) await reg.showNotification(title, opts);
//     else new Notification(title, opts);
//   } catch {}
// }
// ---------- web push ----------
// All system notifications come from the broker as Web Push. It skips a phone whose
// page is in use (visible and focused), which gets our banner instead, so it needs to
// know. Visible without focus is split screen with another app in front: push there.
function sendVisibility() {
  wsSend({ t: "visibility", visible: document.visibilityState === "visible" && document.hasFocus() });
}
function b64uToBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
// Sent on every connect, so the broker always has this phone's current subscription.
async function syncPush() {
  if (!state.pushKey || notifPermission() !== "granted" || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const key = b64uToBytes(state.pushKey);
    const old = sub && sub.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey);
    if (sub && old && (old.length !== key.length || old.some((b, i) => b !== key[i]))) {
      await sub.unsubscribe(); // made for another broker key (e.g. state/ was reset)
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    wsSend({ t: "push-subscribe", subscription: sub.toJSON() });
  } catch {}
}

// Line icons (currentColor) to match the terminal look instead of colour emoji.
const BELL_PATH = '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>';
const BELL_ON = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BELL_PATH}</svg>`;
// Small bell for sessions opted in to push with /notify.
const BELL_PUSH = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BELL_PATH}</svg>`;
const BELL_OFF = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BELL_PATH}<path d="m2 2 20 20"/></svg>`;
function notifPermission() {
  return "Notification" in window ? Notification.permission : "unsupported";
}
function updateNotifUI() {
  const p = notifPermission();
  const btn = $("notifBtn");
  btn.innerHTML = p === "granted" ? BELL_ON : BELL_OFF;
  btn.classList.toggle("on", p === "granted");
  btn.setAttribute("aria-label", p === "granted" ? "Notifications on" : "Enable notifications");
  btn.hidden = p === "unsupported";
  $("notifCard").hidden = !(p === "default" && !store.get(NOTIF_DISMISS_KEY));
}
// Must run from a tap: browsers ignore or auto-block permission prompts without a gesture.
async function enableNotifications() {
  const p = notifPermission();
  if (p === "unsupported") { toast("Notifications aren't supported in this browser"); return; }
  if (p === "granted") { toast("Notifications are on. Turn them off in site settings."); return; }
  if (p === "denied") { toast("Notifications are blocked. Allow them in site settings.", 3500); return; }
  const res = await Notification.requestPermission();
  toast(res === "granted"
    ? "Notifications on ✓ For pop-up banners: long-press a notification → Settings → turn on “Pop on screen”."
    : "Notifications blocked", res === "granted" ? 7000 : 2400);
  updateNotifUI();
  syncPush();
}

// ---------- rendering: list ----------
function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
function renderList(intro = false) {
  const list = $("sessionList");
  const items = [...state.sessions.values()].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  $("emptyList").hidden = items.length > 0;
  $("listLabel").hidden = items.length === 0;
  $("listLabel").textContent = `open sessions · ${items.length}`;
  list.classList.toggle("intro", intro);
  list.innerHTML = "";
  for (const s of items) {
    const st = state.statusById.get(s.id) || {};
    const li = document.createElement("li");
    li.className = "session-item" + (st.working ? " working" : "");
    li.onclick = () => openChat(s.id);
    const draft = state.drafts.get(s.id);
    const ctxTxt = fmtContext(st.context || s.context).text;
    const model = [ctxTxt, [st.model || s.model, st.thinkingLevel || s.thinkingLevel].filter(Boolean).join(" • ")].filter(Boolean).join(" · ");
    const stateHtml = st.working
      ? `<span class="busy pulse">●</span> <span class="busy">working</span>`
      : `<span class="ok">✓</span> idle`;
    li.innerHTML = `
      <div class="s-top">
        <span class="s-name">${esc(s.name)}</span>
        ${s.notify ? `<span class="s-push" title="Push notifications on (/notify)">${BELL_PUSH}</span>` : ""}
        <span class="s-ago">${st.working ? "" : esc(ago(s.lastActivity))}</span>
      </div>
      <div class="s-cwd" title="${esc(s.cwd || "")}">${esc(tildePath(s.cwd))}</div>
      <div class="s-meta">${stateHtml}${model ? " · " + esc(model) : ""}${draft ? ` · <span class="draft">✎ ${esc(draft)}</span>` : ""}</div>`;
    list.appendChild(li);
  }
}
// pi shows paths like "~\Desktop\AI\project"; approximate by collapsing the user profile.
function tildePath(p) {
  if (!p) return "";
  const m = String(p).match(/^(?:[A-Za-z]:[\\/]Users[\\/][^\\/]+|\/(?:home|Users)\/[^/]+)(.*)$/);
  const out = m ? "~" + m[1] : String(p);
  return out.length > 48 ? "…" + out.slice(-47) : out;
}

// ---------- navigation (Android back button returns to the list) ----------
function openChat(sessionId, fromHistory = false) {
  saveDraft();
  state.current = sessionId;
  state.stick = true;
  if (!fromHistory) {
    if (history.state && history.state.chat) history.replaceState({ chat: sessionId }, "");
    else history.pushState({ chat: sessionId }, "");
  }
  const input = $("promptInput");
  input.value = state.drafts.get(sessionId) || "";
  show("chatView");
  renderTray();
  renderTranscript();
  updateChatHeader();
  autosize();
  wsSend({ t: "get-snapshot", sessionId });
  wsSend({ t: "get-commands", sessionId });
  // Deliberately no auto-focus: opening a chat is for reading, so the keyboard
  // stays down until the user taps the input.
}
function goToList() {
  if (history.state && history.state.chat) history.back(); // popstate -> openList
  else openList();
}
function openList() {
  saveDraft();
  $("promptInput").blur();
  state.current = null;
  $("viewTitle").textContent = "pi mobile";
  $("viewSub").textContent = "";
  $("workBar").hidden = true;
  updateNotifUI();
  show("listView");
  renderList(true);
}
function saveDraft() {
  if (!state.current) return;
  const v = $("promptInput").value;
  if (v.trim()) state.drafts.set(state.current, v); else state.drafts.delete(state.current);
}

// ---------- rendering: chat ----------
function updateChatHeader() {
  const s = state.sessions.get(state.current);
  const st = state.statusById.get(state.current) || {};
  $("viewTitle").textContent = s ? s.name : "session";
  $("viewSub").textContent = s ? tildePath(s.cwd) : "";
  // pi-style status line under the editor
  $("slCwd").textContent = s ? tildePath(s.cwd) : "";
  $("slModel").textContent = [st.model || (s && s.model), st.thinkingLevel || (s && s.thinkingLevel)].filter(Boolean).join(" • ");
  const c = fmtContext(st.context);
  const ctxEl = $("slCtx");
  ctxEl.textContent = c.text;
  ctxEl.className = "sl-ctx" + (c.level ? " " + c.level : "");
  ctxEl.title = st.context && st.context.tokens != null ? `${st.context.tokens.toLocaleString()} of ${st.context.window.toLocaleString()} tokens` : "";
  const sl = $("slState");
  if (st.working) {
    sl.className = "sl-working";
    sl.innerHTML = `<span class="working-indicator"><i></i><i></i><i></i></span> working`;
  } else {
    sl.className = "sl-ready";
    sl.textContent = "✓ ready";
  }
  const push = $("slPush");
  push.hidden = !(s && s.notify);
  if (!push.hidden && !push.innerHTML) push.innerHTML = `${BELL_PUSH} push`;
  // Stop + steer/queue controls are only meaningful while the agent is working.
  const wasHidden = $("workBar").hidden;
  $("workBar").hidden = !st.working;
  if (wasHidden !== $("workBar").hidden && state.stick) scrollToBottom();
  updateComposer();
}
function updateComposer() {
  const input = $("promptInput");
  const st = (state.current && state.statusById.get(state.current)) || {};
  if (!state.connected) input.placeholder = "offline · reconnecting…";
  else if (st.working) input.placeholder = state.deliverMode === "steer" ? "steer the current turn…" : "queue a follow-up…";
  else input.placeholder = "message pi…";
  $("sendBtn").disabled = !input.value.trim() && !curAttach().length;
}
function renderTranscript() {
  const t = $("transcript");
  const keep = !state.stick ? t.scrollTop : null;
  t.innerHTML = "";
  const blocks = state.blocks.get(state.current) || [];
  const frag = document.createDocumentFragment();
  state.openTools = [];
  for (const b of blocks) { const el = renderBlock(b); if (el) frag.appendChild(el); }
  t.appendChild(frag);
  if (keep == null) scrollToBottom();
  else t.scrollTop = keep;
  setUnseen(0);
}
function appendBlock(b) {
  const el = renderBlock(b);
  if (el) { el.classList.add("fresh"); $("transcript").appendChild(el); }
  // A tool result merges into its call's panel (el == null): no new row, but keep following.
  if (state.stick) scrollToBottom();
  else if (el) setUnseen(state.unseen + 1);
  return el;
}
function nearBottom() {
  const t = $("transcript");
  return t.scrollHeight - t.scrollTop - t.clientHeight < 60;
}
// Always an instant jump: a smooth scroll emits mid-way scroll events that read as
// "user scrolled up" and would unstick the transcript.
function scrollToBottom() {
  const t = $("transcript");
  requestAnimationFrame(() => { t.scrollTop = t.scrollHeight; });
  state.stick = true;
  setUnseen(0);
}
function setUnseen(n) {
  state.unseen = n;
  $("jumpText").textContent = n > 0 ? `${n} new` : "latest";
  $("jumpBtn").hidden = state.stick || !state.current;
}

// pi footer style: "6.0%/96k"; "?/96k" when usage is unknown (e.g. right after compaction).
function fmtContext(ctx) {
  if (!ctx || !ctx.window) return { text: "", level: "" };
  const win = ctx.window >= 1e6 ? (ctx.window / 1e6).toFixed(ctx.window % 1e6 ? 1 : 0) + "M" : Math.round(ctx.window / 1000) + "k";
  if (ctx.percent == null) return { text: `?/${win}`, level: "" };
  return { text: `${ctx.percent.toFixed(1)}%/${win}`, level: ctx.percent >= 90 ? "high" : ctx.percent >= 70 ? "warn" : "" };
}

function clock(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
}

function renderBlock(b) {
  if (b.kind === "tool_call" || b.kind === "tool_result") return renderTool(b);
  if (b.kind === "thinking") return renderThinking(b);
  if (b.kind === "command") return renderCommand(b);
  if (b.kind === "compaction") return renderCompaction(b);
  const row = document.createElement("div");
  b._el = row;

  // Extension/custom messages: pi draws these as a violet panel.
  if (b.role === "marker") {
    row.className = "row note";
    const box = document.createElement("div");
    box.className = "note-block";
    box.textContent = b.text || "";
    row.appendChild(box);
    return row;
  }

  // Prompts (typed in the TUI or sent from here): full-width slate block, verbatim.
  if (b.role === "user" || b.via === "mobile") {
    row.className = "row user" + (b.failed ? " failed" : "");
    const box = document.createElement("div");
    box.className = "user-block";
    const parts = splitAttach(b.text || "");
    parts.text = stripImageNotes(parts.text);
    if (parts.text) box.appendChild(document.createTextNode(parts.text));
    const att = renderUserAttachments(b, parts.files);
    if (att) box.appendChild(att);
    if (b.via === "mobile") {
      const via = document.createElement("div");
      via.className = "via";
      via.textContent = `↳ via mobile · ${clock(b.ts)}`;
      box.appendChild(via);
    }
    row.appendChild(box);
    if (b.failed) {
      const note = document.createElement("div");
      note.className = "fail-note";
      note.textContent = "✕ not delivered · tap to edit and resend";
      note.onclick = () => restoreFailed(b);
      row.appendChild(note);
    }
    return row;
  }

  // Agent replies: Markdown, straight on the background.
  row.className = "row assistant";
  const body = document.createElement("div");
  body.className = "assistant-text md";
  if (window.renderMarkdown) body.innerHTML = window.renderMarkdown(b.text || ""); // renderer escapes all source text
  else { body.style.whiteSpace = "pre-wrap"; body.textContent = b.text || ""; }
  row.appendChild(body);
  return row;
}

// pi's thinking tree: "┊ Thinking" with a "└─ · first line" preview; tap for the rest.
function renderThinking(b) {
  const row = document.createElement("div");
  row.className = "row assistant";
  const text = String(b.text || "").trim().slice(0, 20000);
  const first = text.split("\n").find((l) => l.trim()) || "";
  const card = document.createElement("div");
  card.className = "think collapsed";
  card.setAttribute("role", "button");
  card.setAttribute("aria-expanded", "false");
  card.innerHTML = `
    <div class="think-head"><span class="glyph">┊</span><span>Thinking</span><span class="chev">▾</span></div>
    <div class="think-preview"><span class="glyph">└─ ·</span><span class="txt">${esc(first)}</span></div>
    <div class="think-body"><span class="glyph">└─</span><span>${esc(text)}</span></div>`;
  card.onclick = () => {
    if (String(getSelection()) && !card.classList.contains("collapsed")) return; // let people select text
    const open = card.classList.toggle("collapsed") === false;
    card.setAttribute("aria-expanded", String(open));
  };
  row.appendChild(card);
  return row;
}

// One-line summary of a tool call's input, e.g. the bash command or file path.
function toolArg(input) {
  if (input == null) return "";
  if (typeof input === "string") return input.split("\n")[0];
  for (const k of ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url"]) {
    if (typeof input[k] === "string" && input[k]) return input[k].split("\n")[0];
  }
  const v = Object.values(input).find((x) => typeof x === "string" && x);
  return v ? String(v).split("\n")[0] : "";
}

function renderTool(b) {
  if (b.kind === "tool_result") {
    const open = state.openTools || [];
    const i = open.findIndex((c) => c.dataset.tool === (b.toolName || "tool"));
    if (i >= 0) { completeTool(open.splice(i, 1)[0], b); return null; }
  }
  const row = document.createElement("div");
  row.className = "row assistant";
  const card = document.createElement("div");
  const isResult = b.kind === "tool_result";
  card.className = "tool collapsed" + (isResult ? (b.isError ? " err" : " ok") : "");
  let ico, arg, bodyText;
  if (isResult) {
    const out = String(b.toolResult || "");
    ico = b.isError ? "✕" : "✓";
    arg = (b.toolInput && toolArg(b.toolInput)) || out.split("\n").find((l) => l.trim()) || "no output";
    bodyText = out;
  } else {
    ico = "▸";
    arg = toolArg(b.toolInput);
    const inp = b.toolInput;
    const keys = inp && typeof inp === "object" ? Object.keys(inp) : [];
    // Single-field inputs read better bare ("$ ls -la") than as JSON.
    if (keys.length === 1 && typeof inp[keys[0]] === "string") {
      bodyText = (/^(bash|shell|exec)$/i.test(b.toolName || "") ? "$ " : "") + inp[keys[0]];
    } else bodyText = fmtInput(inp);
  }
  card.innerHTML = `
    <div class="tool-head" role="button" aria-expanded="false">
      <span class="tool-ico">${ico}</span>
      <span class="tool-name">${esc(b.toolName || "tool")}</span>
      <span class="tool-arg">${esc(arg)}</span>
      <span class="chev">▾</span>
    </div>
    <div class="tool-body">${esc(String(bodyText).slice(0, 20000)) || "&lt;no output&gt;"}</div>`;
  card.dataset.tool = b.toolName || "tool";
  wireToggle(card, ".tool-head");
  row.appendChild(card);
  if (!isResult) (state.openTools || (state.openTools = [])).push(card);
  return row;
}
// Turn a pending call panel into a finished one, like pi's tool box: tint by outcome,
// keep the call's one-line summary, and add the output under the input.
function completeTool(card, b) {
  card.classList.add(b.isError ? "err" : "ok");
  card.querySelector(".tool-ico").textContent = b.isError ? "✕" : "✓";
  const out = String(b.toolResult || "");
  const body = card.querySelector(".tool-body");
  const sep = document.createElement("div");
  sep.className = "tool-sep";
  sep.textContent = b.isError ? "── error ──" : "── output ──";
  const pre = document.createElement("div");
  pre.className = "tool-out";
  pre.textContent = out.slice(0, 20000) || "<no output>";
  body.append(sep, pre);
}
function wireToggle(card, headSel) {
  const head = card.querySelector(headSel);
  head.onclick = () => {
    const open = card.classList.toggle("collapsed") === false;
    head.setAttribute("aria-expanded", String(open));
  };
}
function fmtInput(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try { // fallback for browsers without async clipboard access
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch { return false; }
}

// ---------- compose ----------
let sending = false;
async function sendPrompt() {
  const input = $("promptInput");
  const sessionId = state.current;
  const items = curAttach();
  let text = input.value.trim();
  if ((!text && !items.length) || !sessionId || sending) return;
  hideCmdMenu();
  if (text.startsWith("//")) text = text.slice(1);          // "//foo" sends a literal "/foo" prompt
  else if (text.startsWith("/") && !items.length) { runCommand(text); return; }
  if (!state.connected) { toast("Not connected. Your message is kept; try again once reconnected."); reconnectNow(); return; }

  // Attachments: images are resized and sent inline; other files are uploaded first.
  let images = [], files = [];
  if (items.length) {
    sending = true; updateComposer(); $("sendBtn").disabled = true;
    try {
      for (const it of items) {
        it.busy = true; renderTray();
        if (it.kind === "image" && noVision()) {
          files.push(await uploadFile(it.file)); // pi would replace it with "(image omitted)"
        } else if (it.kind === "image") {
          const im = await prepareImage(it.file).catch(() => null);
          if (im) images.push(im);
          else files.push(await uploadFile(it.file)); // couldn't decode (e.g. HEIC): send as a file
        } else {
          files.push(await uploadFile(it.file));
        }
        it.busy = false;
      }
    } catch (e) {
      for (const it of items) it.busy = false;
      renderTray();
      sending = false; updateComposer();
      toast("Attachment failed: " + (e && e.message ? e.message : "upload error"), 3500);
      return;
    }
    sending = false;
    if (!text && images.length && !files.length) text = images.length > 1 ? "(see attached images)" : "(see attached image)";
  }

  const st = state.statusById.get(sessionId) || {};
  const payload = { t: "send-prompt", sessionId, text };
  if (images.length) payload.images = images;
  if (files.length) payload.files = files;
  if (st.working) payload.deliverAs = state.deliverMode; // steer (interrupt) or queue
  // Offline: keep the text in the box instead of showing a prompt that never went out.
  if (!wsSend(payload)) { renderTray(); updateComposer(); toast("Not connected. Your message is kept; try again once reconnected."); reconnectNow(); return; }
  // Optimistic local echo + remember it so the authoritative copy is deduped.
  const echo = {
    id: "local-" + Date.now(), role: "user", kind: "text", text, via: "mobile", ts: Date.now(),
    local: items.map((it) => ({ kind: it.kind, url: it.url, name: it.file.name, size: it.file.size, file: it.file })),
  };
  state.attaches.delete(sessionId);
  renderTray();
  state.pending.push({ sessionId: state.current, text: normText(text), ts: echo.ts, block: echo });
  const arr = state.blocks.get(state.current) || [];
  arr.push(echo);
  state.blocks.set(state.current, arr);
  state.stick = true;
  appendBlock(echo);
  input.value = "";
  state.drafts.delete(state.current);
  autosize();
  updateComposer();
  // On phones, drop the keyboard so the reply is visible.
  if (IS_TOUCH) input.blur();
}
function markFailed(sessionId, text) {
  const key = normText(text);
  const i = state.pending.findIndex((p) => p.sessionId === sessionId && p.text === key);
  if (i < 0) { toast("Session busy or offline: prompt not delivered"); return; }
  const [p] = state.pending.splice(i, 1);
  p.block.failed = true;
  if (p.block._el && p.block._el.isConnected) p.block._el.replaceWith(renderBlock(p.block));
  if (state.stick) scrollToBottom(); // the bubble grew a "not delivered" note
  toast("Prompt not delivered");
}
function restoreFailed(b) {
  const arr = state.blocks.get(state.current) || [];
  const i = arr.indexOf(b);
  if (i >= 0) arr.splice(i, 1);
  if (b._el) b._el.remove();
  const input = $("promptInput");
  input.value = /^\(see attached images?\)$/.test(b.text || "") ? "" : (b.text || "");
  if (b.local && b.local.length) {
    state.attaches.set(state.current, b.local.map((l) => ({ id: Math.random().toString(36).slice(2), file: l.file, kind: l.kind, url: l.url })));
    renderTray();
  }
  autosize(); updateComposer();
  input.focus();
}
// ---------- slash commands ----------
let cmdSel = 0;
function cmdMatches() {
  const v = $("promptInput").value;
  if (!v.startsWith("/") || v.startsWith("//") || /\s/.test(v)) return null;
  const q = v.slice(1).toLowerCase();
  const all = state.commands.get(state.current) || [];
  return all.filter((c) => c.name.toLowerCase().startsWith(q))
    .concat(q ? all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)) : [])
    .slice(0, 40);
}
function updateCmdMenu() {
  const menu = $("cmdMenu");
  const list = cmdMatches();
  if (!list) { hideCmdMenu(); return; }
  menu.innerHTML = "";
  if (!list.length) {
    const known = (state.commands.get(state.current) || []).length;
    menu.innerHTML = `<div class="cmd-empty">${known ? "No matching command" : "Loading commands…"}</div>`;
  }
  cmdSel = Math.min(cmdSel, Math.max(0, list.length - 1));
  list.forEach((c, i) => {
    const it = document.createElement("div");
    it.className = "cmd-item" + (i === cmdSel ? " sel" : "");
    it.setAttribute("role", "option");
    it.innerHTML = `<span class="cn">/${esc(c.name)}</span>${c.args ? `<span class="ca">${esc(c.args)}</span>` : ""}<span class="cd">${esc(c.description || "")}</span>${c.source && c.source !== "builtin" ? `<span class="cs">${esc(c.source)}</span>` : ""}`;
    it.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the keyboard up
    it.onclick = () => pickCommand(c);
    menu.appendChild(it);
  });
  menu.hidden = false;
}
function hideCmdMenu() { $("cmdMenu").hidden = true; cmdSel = 0; }
function pickCommand(c) {
  const input = $("promptInput");
  input.value = "/" + c.name + " ";
  hideCmdMenu();
  autosize(); updateComposer();
  // Commands that need no argument can run straight away.
  if (!c.args) sendPrompt();
  else input.focus();
}
function runCommand(text) {
  const sessionId = state.current;
  const reqId = Math.random().toString(36).slice(2, 10);
  if (!wsSend({ t: "run-command", sessionId, text, reqId })) { toast("Not connected"); reconnectNow(); return; }
  const block = { id: "cmd-" + reqId, kind: "command", reqId, text, ts: Date.now(), result: { pending: true, text: "running…" } };
  const arr = state.blocks.get(sessionId) || [];
  arr.push(block);
  state.blocks.set(sessionId, arr);
  state.stick = true;
  appendBlock(block);
  const input = $("promptInput");
  input.value = ""; state.drafts.delete(sessionId);
  autosize(); updateComposer();
  if (IS_TOUCH) input.blur();
}
function onCommandResult(msg) {
  const arr = state.blocks.get(msg.sessionId) || [];
  const rows = arr.filter((x) => x.kind === "command" && x.reqId === msg.reqId);
  if (msg.follow) {
    const s = state.sessions.get(msg.sessionId);
    if (s && s.pid) state.follow = { pid: s.pid, oldId: msg.sessionId, until: Date.now() + 20000 };
  }
  if (!rows.length) { if (msg.text && state.current === msg.sessionId) toast(msg.text); return; }
  // Normally one row per command, but update every copy so none is left "running…".
  for (const b of rows) {
    b.result = { ok: msg.ok, pending: !!msg.pending, text: msg.text || "", choices: msg.choices };
    const old = b._el; // renderBlock() repoints b._el at the new row, so keep the live one
    if (old && old.isConnected) old.replaceWith(renderBlock(b));
  }
  if (state.stick) scrollToBottom();
}
// pi's compaction marker: one line, tap to read the summary the model now works from.
function renderCompaction(b) {
  const row = document.createElement("div");
  row.className = "row compaction";
  b._el = row;
  const card = document.createElement("div");
  card.className = "compact collapsed";
  const head = document.createElement("div");
  head.className = "compact-head";
  const k = b.tokensBefore ? ` from ${Math.round(b.tokensBefore / 1000)}k tokens` : "";
  head.innerHTML = `<span class="glyph">⟳</span><span></span><span class="chev">▸</span>`;
  head.children[1].textContent = `Context compacted${k} · ${clock(b.ts)}`;
  card.appendChild(head);
  if (b.text) {
    const body = document.createElement("div");
    body.className = "compact-body md";
    if (window.renderMarkdown) body.innerHTML = window.renderMarkdown(b.text); // renderer escapes all source text
    else { body.style.whiteSpace = "pre-wrap"; body.textContent = b.text; }
    card.appendChild(body);
    card.onclick = (e) => {
      if (e.target.closest("a")) return;
      const open = card.classList.toggle("collapsed") === false;
      head.querySelector(".chev").textContent = open ? "▾" : "▸";
    };
  } else head.querySelector(".chev").remove();
  row.appendChild(card);
  return row;
}
function renderCommand(b) {
  const row = document.createElement("div");
  row.className = "row cmdrow";
  b._el = row;
  const line = document.createElement("div");
  line.className = "cmd-line";
  line.innerHTML = `<span class="prompt">❯</span>`;
  line.appendChild(document.createTextNode(b.text));
  row.appendChild(line);
  const r = b.result || {};
  const out = document.createElement("div");
  out.className = "cmd-out " + (r.pending ? "pending" : r.ok ? "ok" : "err");
  out.textContent = r.text || "";
  row.appendChild(out);
  if (Array.isArray(r.choices) && r.choices.length) {
    const box = document.createElement("div");
    box.className = "cmd-choices";
    for (const c of r.choices) {
      const btn = document.createElement("button");
      btn.className = "cmd-choice";
      btn.textContent = c.label;
      btn.onclick = () => runCommand(c.value);
      box.appendChild(btn);
    }
    out.appendChild(box);
  }
  return row;
}

// ---------- attachments ----------
// pi appends "[Image: original WxH, displayed at …]" to the text when it resizes an image.
const IMAGE_NOTE_RE = /\s*\[Image: original \d+x\d+, displayed at \d+x\d+\.[^\]]*\]/g;
function stripImageNotes(t) { return String(t || "").replace(IMAGE_NOTE_RE, "").trim(); }
const ATTACH_MARKER = "📎 Attached from phone:";
const MAX_IMAGES = 8, MAX_FILE_BYTES = 50 * 1024 * 1024;
function curAttach() { return (state.current && state.attaches.get(state.current)) || []; }
function fmtBytes(n) {
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return Math.round(n / 1024) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
// Split the file list the extension appends ("📎 Attached from phone:\n- name (size): path").
function splitAttach(text) {
  const t = String(text || "");
  let i = t.indexOf("\n\n" + ATTACH_MARKER), skip = 2;
  if (i < 0 && t.startsWith(ATTACH_MARKER)) { i = 0; skip = 0; }
  if (i < 0) return { text: t, files: [] };
  const files = t.slice(i + skip + ATTACH_MARKER.length).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "))
    .map((l) => {
      const m = l.slice(2).match(/^(.*?)(?: \(([^)]*)\))?: (.+)$/);
      return m ? { name: m[1], size: m[2] || "", path: m[3] } : { name: l.slice(2), size: "", path: "" };
    });
  return { text: t.slice(0, i), files };
}
function addFiles(list) {
  if (!state.current || !list || !list.length) return;
  const arr = state.attaches.get(state.current) || [];
  let skipped = 0;
  for (const file of list) {
    const isImg = /^image\/(png|jpeg|gif|webp|heic|heif)$/.test(file.type);
    if (file.size > MAX_FILE_BYTES) { skipped++; continue; }
    if (isImg && arr.filter((a) => a.kind === "image").length >= MAX_IMAGES) { skipped++; continue; }
    arr.push({ id: Math.random().toString(36).slice(2), file, kind: isImg ? "image" : "file", url: isImg ? URL.createObjectURL(file) : null });
  }
  state.attaches.set(state.current, arr);
  if (skipped) toast(`Skipped ${skipped}: max ${MAX_IMAGES} images, 50 MB per file`, 3000);
  renderTray(); updateComposer();
  if (state.stick) scrollToBottom();
}
function removeAttach(id) {
  const arr = curAttach();
  const i = arr.findIndex((a) => a.id === id);
  if (i < 0) return;
  const [it] = arr.splice(i, 1);
  if (it.url) URL.revokeObjectURL(it.url);
  renderTray(); updateComposer();
}
function noVision() {
  const st = (state.current && state.statusById.get(state.current)) || {};
  return st.vision === false;
}
function renderTray() {
  const hasImg = curAttach().some((a) => a.kind === "image");
  const warn = $("visionWarn");
  warn.hidden = !(hasImg && noVision());
  if (!warn.hidden) {
    const st = state.statusById.get(state.current) || {};
    warn.textContent = `⚠ ${st.model || "this model"} can't see images, so they'll be sent as files. Switch with /model.`;
  }
  const tray = $("attachTray");
  const arr = curAttach();
  tray.hidden = arr.length === 0;
  tray.innerHTML = "";
  for (const it of arr) {
    const chip = document.createElement("div");
    chip.className = "chip" + (it.kind === "image" ? " img" : "") + (it.busy ? " busy" : "");
    chip.innerHTML = it.kind === "image"
      ? `<img src="${it.url}" alt="${esc(it.file.name)}" />`
      : `<span class="ico">▤</span><span class="meta"><span class="name">${esc(it.file.name)}</span><span class="size">${esc(fmtBytes(it.file.size))}</span></span>`;
    const rm = document.createElement("button");
    rm.className = "rm"; rm.textContent = "✕"; rm.setAttribute("aria-label", "Remove " + it.file.name);
    rm.onclick = () => removeAttach(it.id);
    keepFocus(rm);
    chip.appendChild(rm);
    tray.appendChild(chip);
  }
}
// Images: keep small ones as-is; downscale big ones to <=2048px JPEG so prompts stay light.
async function prepareImage(file) {
  const okType = /^image\/(png|jpeg|gif|webp)$/.test(file.type);
  const bmp = await loadImage(file); // throws if the browser can't decode it
  const max = 2000, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (okType && scale === 1 && file.size <= 1.5 * 1048576) {
    return { data: await blobToBase64(file), mimeType: file.type };
  }
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height); // JPEG has no alpha
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  if (!blob) throw new Error("encode failed");
  return { data: await blobToBase64(blob), mimeType: "image/jpeg" };
}
function loadImage(file) {
  if (window.createImageBitmap) return createImageBitmap(file);
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img); img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
async function uploadFile(file) {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name || "file")}`, {
    method: "POST",
    headers: { "x-pi-token": state.token || "", "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (res.status === 413) throw new Error(`${file.name} is over 50 MB`);
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  return res.json();
}
function renderUserAttachments(b, files) {
  const local = b.local || [];
  const imgs = local.filter((l) => l.kind === "image");
  const n = imgs.length || b.images || 0;
  const fileList = files.length ? files : local.filter((l) => l.kind === "file").map((l) => ({ name: l.name, size: fmtBytes(l.size) }));
  if (!n && !fileList.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "ub-attach";
  if (imgs.length) {
    for (const l of imgs) {
      const img = document.createElement("img");
      img.src = l.url; img.alt = l.name;
      img.onclick = (e) => { e.stopPropagation(); window.open(l.url, "_blank"); };
      wrap.appendChild(img);
    }
  } else if (n) {
    const chip = document.createElement("span");
    chip.className = "ub-file";
    chip.textContent = n > 1 ? `▣ ${n} images` : "▣ image";
    wrap.appendChild(chip);
  }
  for (const f of fileList) {
    const chip = document.createElement("span");
    chip.className = "ub-file";
    chip.title = f.path || "";
    chip.innerHTML = `<span>▤</span><span class="name">${esc(f.name)}</span>${f.size ? `<span class="size">${esc(f.size)}</span>` : ""}`;
    wrap.appendChild(chip);
  }
  return wrap;
}

function autosize() {
  const el = $("promptInput");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight + 2, 132) + "px";
}
function stopSession() {
  if (!state.current) return;
  if (!wsSend({ t: "stop", sessionId: state.current })) { toast("Not connected"); return; }
  $("stopBtn").disabled = true;
  setTimeout(() => { $("stopBtn").disabled = false; }, 4000);
}
function setDeliverMode(mode) {
  state.deliverMode = mode === "followUp" ? "followUp" : "steer";
  for (const b of document.querySelectorAll(".seg-btn")) {
    b.classList.toggle("active", b.dataset.mode === state.deliverMode);
  }
  updateComposer();
}

// ---------- wire up ----------
// Tapping a button while typing would blur the input first, the keyboard would
// collapse, the layout would jump and the tap could land on the wrong thing.
// Keeping focus on pointerdown makes these buttons work with the keyboard up.
function keepFocus(el) {
  el.addEventListener("pointerdown", (e) => e.preventDefault());
  el.addEventListener("mousedown", (e) => e.preventDefault());
}

function initUI() {
  $("backBtn").onclick = goToList;
  $("notifBtn").onclick = enableNotifications;
  $("notifEnable").onclick = enableNotifications;
  $("notifDismiss").onclick = () => { store.set(NOTIF_DISMISS_KEY, "1"); updateNotifUI(); };
  $("sendBtn").onclick = sendPrompt;
  $("stopBtn").onclick = stopSession;
  $("jumpBtn").onclick = () => scrollToBottom();
  wireHeadsUp();
  keepFocus($("sendBtn")); keepFocus($("stopBtn")); keepFocus($("jumpBtn"));
  $("attachBtn").onclick = () => $("fileInput").click();
  $("fileInput").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  for (const b of document.querySelectorAll(".seg-btn")) {
    b.onclick = () => setDeliverMode(b.dataset.mode);
    keepFocus(b);
  }

  const input = $("promptInput");
  input.enterKeyHint = IS_TOUCH ? "enter" : "send";
  input.addEventListener("input", () => { autosize(); updateComposer(); updateCmdMenu(); });
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) hideCmdMenu(); }, 150));
  input.addEventListener("keydown", (e) => {
    const menu = $("cmdMenu");
    if (menu.hidden) return;
    const list = cmdMatches() || [];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      cmdSel = (cmdSel + (e.key === "ArrowDown" ? 1 : -1) + list.length) % Math.max(1, list.length);
      updateCmdMenu();
    } else if ((e.key === "Tab" || e.key === "Enter") && list[cmdSel]) {
      e.preventDefault(); e.stopImmediatePropagation();
      pickCommand(list[cmdSel]);
    } else if (e.key === "Escape") hideCmdMenu();
  });
  // Pasting an image (e.g. a screenshot) attaches it.
  input.addEventListener("paste", (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    if (IS_TOUCH ? (e.ctrlKey || e.metaKey) : !e.shiftKey) { e.preventDefault(); sendPrompt(); }
  });
  input.addEventListener("focus", () => {
    document.body.classList.add("kb-open");
    if (state.stick) setTimeout(() => scrollToBottom(), 250); // after the keyboard animates in
  });
  input.addEventListener("blur", () => document.body.classList.remove("kb-open"));

  const t = $("transcript");
  t.addEventListener("scroll", () => {
    state.stick = nearBottom();
    if (state.stick) setUnseen(0); else $("jumpBtn").hidden = false;
  }, { passive: true });
  // Copy buttons on code blocks.
  t.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest(".md-copy");
    if (!btn) return;
    const code = btn.closest(".md-code").querySelector("code").textContent;
    copyText(code).then((ok) => {
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
  });
  // Tapping the transcript dismisses the keyboard (unless selecting text).
  t.addEventListener("click", () => {
    if (document.activeElement === input && !String(getSelection())) input.blur();
  });

  if (window.visualViewport) {
    visualViewport.addEventListener("resize", syncViewport);
    visualViewport.addEventListener("scroll", syncViewport);
  }
  window.addEventListener("resize", syncViewport);
  syncViewport();

  window.addEventListener("popstate", (e) => {
    const id = e.state && e.state.chat;
    if (id && state.sessions.has(id)) openChat(id, true);
    else if (state.current) openList();
  });

  // SW messages (notification tap -> open session)
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const id = e.data && e.data.openSession;
      if (!id) return;
      if (state.sessions.has(id)) openChat(id);
      else state.pendingOpen = id;
    });
  }
  document.addEventListener("visibilitychange", () => {
    sendVisibility();
    if (document.hidden) { saveDraft(); return; }
    if (!state.ws || state.ws.readyState > 1) reconnectNow();
    updateNotifUI();
    syncPush(); // permission may have been granted in site settings meanwhile
    if (!state.current) renderList(); // refresh "Xm ago"
  });
  // Split screen moves focus between apps without a visibility change.
  window.addEventListener("focus", sendVisibility);
  window.addEventListener("blur", sendVisibility);
  setInterval(() => { if (!state.current && !document.hidden && !$("listView").hidden) renderList(); }, 60000);
}

async function boot() {
  initUI();
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("/sw.js"); } catch {}
  }
  // The hash is either a pairing code (from the QR) or "open=<id>" (from a notification tap).
  const hash = (location.hash || "").replace(/^#/, "").trim();
  if (hash) history.replaceState(null, "", location.pathname);
  if (hash.startsWith("open=")) state.pendingOpen = decodeURIComponent(hash.slice(5)) || null;
  else if (hash && !(await tryPair(hash)) && state.token) toast("That QR code expired. You're still paired.", 3500);

  if (!state.token) { show("pairView"); return; }
  openList();
  connect();
}
boot();
