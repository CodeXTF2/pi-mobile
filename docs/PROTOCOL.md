# Pi Mobile — wire protocol

Three channels, all JSON messages with a `t` (type) field.

## 1. Loopback channel — extension ⇄ broker

Plain WS on `ws://127.0.0.1:<loopbackPort>`. Every message from an extension must
carry the broker `secret` (read from `state/secret`) until the broker sends `welcome`.
127.0.0.1-bound + secret-gated: only local processes that can read `state/` participate.

**extension → broker**
- `{t:"hello", role:"session", secret, session:{id,name,cwd,pid,sessionFile,model,thinkingLevel}}`
- `{t:"snapshot", sessionId, blocks:[Block], status:Status}` — full current branch
- `{t:"block", sessionId, block:Block}` — one appended block
- `{t:"status", sessionId, status:Status}` — working/idle, model, name, context%
- `{t:"settled", sessionId, aborted:boolean, title, body}` — **full turn complete**
- `{t:"create-pairing", reqId}` — ask broker to mint a pairing code
- `{t:"list-devices", reqId}` / `{t:"revoke-device", reqId, deviceId}`
- `{t:"set-notify", reqId, sessionId, on?}` (toggles without `on`) / `{t:"get-notify", reqId, sessionId}`
  → `{t:"notify", reqId, sessionId, on, webPush, devices}` — `/notify`: opt a session in to Web Push
- `{t:"bye", sessionId}`

**broker → extension**
- `{t:"welcome", loopbackOk:true}`
- `{t:"command", sessionId, text, reqId}` / `{t:"get-commands", sessionId}` — phone slash commands (results go back as `command-result` / `commands`)
- `{t:"prompt", sessionId, text, deliverAs?, images?:[{data,mimeType}], files?:[{path,name,size}]}` — inject into this session
  (images become image content; files are listed under a `📎 Attached from phone:` line with their saved paths)
- `{t:"pairing", reqId, bootstrapUrl, httpsUrl, code, expiresInSec, host, httpsPort}`
- `{t:"devices", reqId, devices:[{id,label,createdAt,lastSeen}]}`
- `{t:"revoked", reqId, deviceId}`

## 2. Phone channel — PWA ⇄ broker

WSS on `wss://<lanIp>:<httpsPort>/ws?token=<deviceToken>` (token issued at pairing).

**phone → broker**
- `{t:"subscribe"}` — begin receiving session list + live events
- `{t:"get-snapshot", sessionId}`
- `{t:"visibility", visible}` — `visible` means in use (visible and focused); sent on
  connect and on every visibility or focus change. The broker Web-Pushes turn
  completions only to phones with no page in use
- `{t:"push-subscribe", subscription:{endpoint, keys:{p256dh, auth}}}` — the page's
  `PushSubscription.toJSON()`, sent on every connect once notifications are allowed
- `{t:"get-commands", sessionId}` → `{t:"commands", sessionId, commands:[{name,description,args?,source}]}`
- `{t:"run-command", sessionId, text:"/compact …", reqId}` → one or more
  `{t:"command-result", sessionId, reqId, command, ok, text, pending?, choices?:[{label,value}], follow?}`
  (`choices` values are commands to run; `follow` = a new session is replacing this one)
- `{t:"send-prompt", sessionId, text, deliverAs?, images?, files?}` — images inline as base64
  (png/jpeg/gif/webp, max 8, phone downsizes to ≤2048px); `files` are results of `/api/upload`.
  The broker only forwards file paths inside its own `state/uploads/`.

**broker → phone**
- `{t:"sessions", sessions:[SessionMeta]}`
- `{t:"snapshot", sessionId, blocks:[Block], status:Status}`
- `{t:"block", sessionId, block:Block}`
- `{t:"status", sessionId, status:Status}`
- `{t:"settled", sessionId, aborted, title, body, push}` — updates the session's state;
  a page in use shows an in-app banner for sessions with `notify:true`. The page no
  longer shows system notifications itself (disabled for now); `push:true` means this
  phone was sent a Web Push
- `{t:"push-key", key}` — the broker's VAPID public key (not sent when Web Push is off)
- `{t:"session-removed", sessionId}`
- `{t:"prompt-echo", sessionId, text}` — confirms our injected prompt landed

## 3. Bootstrap/REST — phone ⇄ broker

Plain HTTP on `http://<lanIp>:<httpPort>` (pre-trust, for CA install only):
- `GET /` , `/pair` → bootstrap page (install CA, then continue to HTTPS)
- `GET /ca.crt` → CA certificate (`application/x-x509-ca-cert`)
- `GET /pair-info` → `{host, httpsPort}`

HTTPS on `https://<lanIp>:<httpsPort>` (post-trust):
- static PWA (`/`, `/app.js`, …)
- `POST /api/pair {code}` → `{token, deviceId}` (single-use, 5-min code)
- `POST /api/upload?name=<file>` (header `x-pi-token`, raw body, ≤50 MB) → `{path, name, size, mimeType}`;
  saved to `state/uploads/<date>/`
- `GET /api/ping` (token) → `{ok:true}`

## 4. Web Push — broker → push service → phone

When a turn settles in a session opted in with `/notify` (`notify:true` in the
session list), each paired phone with a push subscription and no visible page gets an
RFC 8291 (aes128gcm) encrypted push, signed with VAPID (RFC 8292). Payload:
`{title, body, sessionId}`; headers `TTL: 21600`, `Urgency: high`, and a `Topic`
derived from the session id so an offline phone gets one message per session. The
service worker shows it. A 404/410 from the push service deletes the subscription.

## Types

```
Block = {
  id, role,            // user | assistant | toolResult | system | marker
  kind,                // text | thinking | tool_call | tool_result
  text?, toolName?, toolInput?, toolResult?, isError?, durationMs?,
  via?,                // "mobile" when injected from Pi Mobile
  images?,             // user messages: number of attached images
  ts
}
SessionMeta = { id, name, cwd, model, status, working, lastActivity, blockCount }
Status = { working:boolean, model?, name?, contextPercent?, thinkingLevel? }
```
