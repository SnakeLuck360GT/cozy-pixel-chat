// Live updates over one WebSocket per open tab: new messages, typing,
// read markers, who's online and call signalling. Sockets log in with the
// session cookie, and the server decides what each one is told.

import { WebSocketServer } from "ws";

const PING_MS = 30_000;

export function createLive({ authenticate, originAllowed, onConnect, onEvent, onDisconnect }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  // User id -> that user's open sockets (one per tab or device).
  const sockets = new Map();

  function refuse(socket, status) {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  // Called from the HTTP server's "upgrade" event. Another site can open a
  // WebSocket with our cookies attached, so the Origin has to be ours.
  function upgrade(req, socket, head) {
    if (!originAllowed(req)) return refuse(socket, "403 Forbidden");
    const auth = authenticate(req.headers.cookie);
    if (!auth) return refuse(socket, "401 Unauthorized");

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = auth.user.id;
      ws.sessionHash = auth.sessionHash;
      ws.alive = true;
      let mine = sockets.get(ws.userId);
      const first = !mine;
      if (!mine) sockets.set(ws.userId, (mine = new Set()));
      mine.add(ws);

      ws.on("pong", () => (ws.alive = true));
      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          return;
        }
        if (typeof event?.t !== "string") return;
        Promise.resolve()
          .then(() => onEvent(ws, event))
          .catch((err) => {
            if (!err.status) console.error(err);
            send(ws, { t: "error", error: err.status ? err.message : "Something went wrong" });
          });
      });
      ws.on("close", () => {
        mine.delete(ws);
        const last = mine.size === 0;
        if (last) sockets.delete(ws.userId);
        onDisconnect(ws, last);
      });

      onConnect(ws, first);
    });
  }

  // Drops sockets whose connection died without closing (phones going to sleep).
  setInterval(() => {
    for (const mine of sockets.values()) {
      for (const ws of mine) {
        if (!ws.alive) {
          ws.terminate();
          continue;
        }
        ws.alive = false;
        ws.ping();
      }
    }
  }, PING_MS).unref();

  function send(ws, event) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(event));
  }

  function sendTo(userIds, event) {
    const data = JSON.stringify(event);
    for (const id of userIds) {
      for (const ws of sockets.get(id) ?? []) if (ws.readyState === 1) ws.send(data);
    }
  }

  const sendAll = (event) => sendTo([...sockets.keys()], event);

  // Logging out, changing a password or deleting an account closes the
  // sockets that were opened with the old session.
  function close(match) {
    for (const mine of sockets.values()) {
      for (const ws of mine) if (match(ws)) ws.close(4001, "Logged out");
    }
  }

  return {
    upgrade,
    send,
    sendTo,
    sendAll,
    close,
    socketsOf: (userId) => [...(sockets.get(userId) ?? [])],
    isOnline: (userId) => sockets.has(userId),
    onlineIds: () => [...sockets.keys()],
  };
}
