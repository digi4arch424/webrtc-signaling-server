/**
 * server.js — WebRTC Signaling Server
 * webrtc-signaling-server
 *
 * General purpose WebSocket signaling relay for WebRTC peer connections.
 * Handles SDP offer/answer and ICE candidate exchange between peers.
 *
 * Message format (all messages):
 * {
 *   type:      string,   // message type (see below)
 *   sessionId: string,   // room/session identifier (e.g. camera ID)
 *   role:      string,   // "sender" | "viewer"
 *   payload:   any,      // message-specific data
 *   timestamp: number,   // Unix ms
 * }
 *
 * Message types:
 *   register         — peer registers with a role and sessionId
 *   offer            — sender sends SDP offer
 *   answer           — viewer sends SDP answer
 *   ice-candidate    — either peer sends ICE candidate
 *   sender-ready     — server notifies viewer that sender is online
 *   viewer-ready     — server notifies sender that viewer is waiting
 *   sender-left      — server notifies viewer that sender disconnected
 *   viewer-left      — server notifies sender that viewer disconnected
 *   error            — server sends error to peer
 *
 * Session model:
 *   One sender + multiple viewers per sessionId.
 *   Viewers are stored as a Set — supports future multi-viewer.
 *   Currently relays to first viewer only (MVP). Multi-viewer at M7.
 *
 * Deploy: Render.com free tier
 *   Build: npm install
 *   Start: node server.js
 */

const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// sessions: Map<sessionId, { sender: WebSocket|null, viewers: Set<WebSocket> }>
const sessions = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { sender: null, viewers: new Set() });
  }
  return sessions.get(sessionId);
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...msg, timestamp: Date.now() }));
  }
}

function sendError(ws, message) {
  send(ws, { type: "error", payload: { message } });
}

function log(msg, data = "") {
  console.log(`[${new Date().toISOString()}] ${msg}`, data);
}

function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.sender && session.viewers.size === 0) {
    sessions.delete(sessionId);
    log(`Session removed: ${sessionId}`);
  }
}

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status:   "ok",
    service:  "WebRTC Signaling Server",
    sessions: sessions.size,
    uptime:   Math.floor(process.uptime()) + "s",
  });
});

// ── WebSocket handler ─────────────────────────────────────────────────────────

wss.on("connection", (ws, req) => {
  let role      = null;
  let sessionId = null;

  log("New connection from", req.socket.remoteAddress);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      sendError(ws, "Invalid JSON");
      return;
    }

    const { type, payload } = msg;
    const sid = msg.sessionId || "default";

    // ── Register ────────────────────────────────────────────────────────────
    if (type === "register") {
      role      = msg.role;
      sessionId = sid;

      if (!role || !["sender", "viewer"].includes(role)) {
        sendError(ws, "Invalid role — must be 'sender' or 'viewer'");
        return;
      }

      const session = getOrCreateSession(sessionId);

      if (role === "sender") {
        // Disconnect existing sender if present
        if (session.sender && session.sender !== ws) {
          send(session.sender, { type: "error", sessionId, payload: { message: "Replaced by new sender" } });
          session.sender.close();
        }
        session.sender = ws;
        log(`Sender registered: ${sessionId}`);

        // Notify all waiting viewers
        session.viewers.forEach(viewer => {
          send(viewer, { type: "sender-ready", sessionId });
        });

      } else if (role === "viewer") {
        session.viewers.add(ws);
        log(`Viewer registered: ${sessionId} (${session.viewers.size} viewers)`);

        // Notify sender a viewer is waiting
        if (session.sender) {
          send(session.sender, { type: "viewer-ready", sessionId });
        }
      }

      // Confirm registration
      send(ws, { type: "registered", sessionId, role });
      return;
    }

    // ── Require registration for all other messages ──────────────────────────
    if (!role || !sessionId) {
      sendError(ws, "Not registered");
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      sendError(ws, "Session not found");
      return;
    }

    // ── Relay SDP and ICE ────────────────────────────────────────────────────
    if (type === "offer") {
      // Sender → first viewer (MVP — multi-viewer at M7)
      const firstViewer = [...session.viewers][0];
      if (firstViewer) {
        send(firstViewer, { type: "offer", sessionId, payload });
        log(`Offer relayed: ${sessionId}`);
      } else {
        sendError(ws, "No viewer connected");
      }

    } else if (type === "answer") {
      // Viewer → sender
      if (session.sender) {
        send(session.sender, { type: "answer", sessionId, payload });
        log(`Answer relayed: ${sessionId}`);
      } else {
        sendError(ws, "No sender connected");
      }

    } else if (type === "ice-candidate") {
      // Relay to the other party
      if (role === "sender") {
        const firstViewer = [...session.viewers][0];
        if (firstViewer) send(firstViewer, { type: "ice-candidate", sessionId, payload });
      } else if (role === "viewer") {
        if (session.sender) send(session.sender, { type: "ice-candidate", sessionId, payload });
      }

    } else {
      sendError(ws, `Unknown message type: ${type}`);
    }
  });

  ws.on("close", () => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;

    if (role === "sender" && session.sender === ws) {
      session.sender = null;
      log(`Sender left: ${sessionId}`);
      session.viewers.forEach(viewer => {
        send(viewer, { type: "sender-left", sessionId });
      });
    } else if (role === "viewer") {
      session.viewers.delete(ws);
      log(`Viewer left: ${sessionId} (${session.viewers.size} remaining)`);
      if (session.sender) {
        send(session.sender, { type: "viewer-left", sessionId });
      }
    }

    cleanupSession(sessionId);
  });

  ws.on("error", (err) => {
    log("WebSocket error:", err.message);
  });
});

server.listen(PORT, () => {
  log(`WebRTC signaling server running on port ${PORT}`);
});
