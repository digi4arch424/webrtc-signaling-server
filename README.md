# webrtc-signaling-server

General purpose WebRTC signaling server. Relays SDP offers/answers and ICE candidates between peers via WebSocket. No PeerJS dependency — pure WebRTC API compatible.

Deploy to Render.com free tier.

---

## Message Format

All messages are JSON with this envelope:

```json
{
  "type":      "register | offer | answer | ice-candidate | ...",
  "sessionId": "site-cam-001",
  "role":      "sender | viewer",
  "payload":   {},
  "timestamp": 1712345678000
}
```

### Message Types

| Type | Direction | Description |
|---|---|---|
| `register` | Client → Server | Register as sender or viewer for a session |
| `registered` | Server → Client | Confirm registration |
| `offer` | Sender → Server → Viewer | SDP offer |
| `answer` | Viewer → Server → Sender | SDP answer |
| `ice-candidate` | Either → Server → Other | ICE candidate |
| `sender-ready` | Server → Viewer | Sender came online |
| `viewer-ready` | Server → Sender | Viewer connected |
| `sender-left` | Server → Viewer | Sender disconnected |
| `viewer-left` | Server → Sender | Viewer disconnected |
| `error` | Server → Client | Error message |

---

## Session Model

- One sender + multiple viewers per `sessionId`
- Sessions are created on first registration, cleaned up when empty
- `sessionId` maps to a camera or stream source (e.g. `site-cam-001`)

---

## Deploy to Render.com

1. Create new GitHub repo with these files
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect repo and set:

| Field | Value |
|---|---|
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Instance Type** | Free |

4. Get your URL: `https://YOUR-NAME.onrender.com`

---

## Health Check

```
GET https://YOUR-NAME.onrender.com/
```

Returns:
```json
{ "status": "ok", "service": "WebRTC Signaling Server", "sessions": 0, "uptime": "42s" }
```

---

## Client Usage

```js
const ws = new WebSocket("wss://YOUR-NAME.onrender.com");

ws.onopen = () => {
  ws.send(JSON.stringify({
    type:      "register",
    sessionId: "site-cam-001",
    role:      "sender",
  }));
};

ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  // handle: offer, answer, ice-candidate, viewer-ready, etc.
};
```

---

## Scaling Notes

| Need | Change |
|---|---|
| Multiple viewers | Already supported — viewers stored as a Set |
| Multi-camera | Already supported — sessions keyed by `sessionId` |
| Authentication | Add JWT check in `ws.on("connection")` |
| Persistence | Add Redis for session state across instances |
| Multiple instances | Add Redis pub/sub for cross-instance relay |

---

## Related Repos

- [site-eye-webRTC](https://github.com/digi4arch424/site-eye-webRTC) — Construction Camera System
- [webrtc-network-modules](https://github.com/digi4arch424/webrtc-network-modules) — Module A/B/C networking
