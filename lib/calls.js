// Calls work like a room attached to each chat, Discord-style. Starting one
// rings the others; anyone in the chat can join, leave and rejoin while it's
// open. It closes when the last person leaves, or after someone has waited
// on their own for three minutes. The audio and video go between the
// browsers directly (or through the TURN relay); the server only passes
// connection details around. Nothing is recorded.

import { HttpError } from "./auth.js";

const RING_MS = 45_000;
const ALONE_MS = 3 * 60_000;
export const MAX_IN_CALL = 6;

export function createCalls({ live, membersOf, logCall }) {
  // Conversation id -> { c, video, started, startedBy, members: Map(user id -> socket), ringing: Set, connected }
  const rooms = new Map();

  const roomOf = (ws) => [...rooms.values()].find((r) => r.members.get(ws.userId) === ws);
  const inCall = (userId) => [...rooms.values()].some((r) => r.members.has(userId));

  function view(room) {
    if (!room) return null;
    return { members: [...room.members.keys()], video: room.video, started: room.started, aloneUntil: room.aloneUntil ?? null };
  }

  // Everyone in the chat sees whether a call is going and who's in it.
  const announce = (room) => live.sendTo(membersOf(room.c), { t: "call-room", c: room.c, room: rooms.get(room.c) === room ? view(room) : null });

  function stopRinging(room, userIds = [...room.ringing]) {
    for (const id of userIds) {
      room.ringing.delete(id);
      live.sendTo([id], { t: "call-ring-stop", c: room.c });
    }
  }

  // On your own, the call waits three minutes for someone, then ends.
  function checkAlone(room) {
    clearTimeout(room.aloneTimer);
    room.aloneUntil = null;
    if (room.members.size !== 1) return;
    room.aloneUntil = Date.now() + ALONE_MS;
    room.aloneTimer = setTimeout(() => {
      const [ws] = room.members.values();
      live.send(ws, { t: "call-left", c: room.c, reason: "alone" });
      room.members.clear();
      close(room);
    }, ALONE_MS);
  }

  // status: "ended" once two people have been in it, otherwise "missed" or "declined".
  function close(room, status) {
    if (rooms.get(room.c) !== room) return;
    rooms.delete(room.c);
    clearTimeout(room.aloneTimer);
    clearTimeout(room.ringTimer);
    stopRinging(room);
    announce(room);
    const duration = room.connected ? Date.now() - room.connected : 0;
    logCall(room.c, room.startedBy, { video: room.video, status: status ?? (room.connected ? "ended" : "missed"), duration });
  }

  function leave(ws, room = roomOf(ws)) {
    if (!room || room.members.get(ws.userId) !== ws) return;
    room.members.delete(ws.userId);
    for (const other of room.members.values()) live.send(other, { t: "call-peer-left", c: room.c, user: ws.userId });
    if (!room.members.size) return close(room);
    checkAlone(room);
    announce(room);
  }

  function join(ws, c, video) {
    const members = membersOf(c);
    if (!members.includes(ws.userId)) throw new HttpError(404, "No such chat");
    const current = roomOf(ws);
    if (current && current.c !== c) leave(ws, current);

    let room = rooms.get(c);
    // Joining from another tab or device takes over from the old one.
    const old = room?.members.get(ws.userId);
    if (old && old !== ws) {
      live.send(old, { t: "call-left", c, reason: "elsewhere" });
      leave(old, room);
      room = rooms.get(c);
    }
    if (room?.members.get(ws.userId) === ws) return;

    if (!room) {
      room = { c, video, started: Date.now(), startedBy: ws.userId, members: new Map(), ringing: new Set(), connected: null };
      rooms.set(c, room);
      for (const id of members) {
        if (id === ws.userId || !live.isOnline(id) || inCall(id)) continue;
        room.ringing.add(id);
        live.sendTo([id], { t: "call-ring", c, from: ws.userId, video });
      }
      room.ringTimer = setTimeout(() => stopRinging(room), RING_MS);
    }
    if (room.members.size >= MAX_IN_CALL) throw new HttpError(409, `Calls can have at most ${MAX_IN_CALL} people`);

    const peers = [...room.members.keys()];
    room.members.set(ws.userId, ws);
    stopRinging(room, [ws.userId].filter((id) => room.ringing.has(id)));
    if (room.members.size >= 2) room.connected ??= Date.now();
    // The newcomer connects to everyone already there.
    live.send(ws, { t: "call-joined", c, peers });
    for (const id of peers) live.send(room.members.get(id), { t: "call-peer-joined", c, user: ws.userId });
    checkAlone(room);
    announce(room);
  }

  function decline(ws, c) {
    const room = rooms.get(c);
    if (!room?.ringing.has(ws.userId)) return;
    stopRinging(room, [ws.userId]);
    // Turning down a call nobody else is ringing for ends it for the caller.
    if (room.members.size === 1 && !room.connected && !room.ringing.size) {
      const [caller] = room.members.values();
      live.send(caller, { t: "call-left", c, reason: "declined" });
      room.members.clear();
      close(room, "declined");
    }
  }

  function handle(ws, event) {
    const c = Number(event.c);
    if (event.t === "call-join") join(ws, c, Boolean(event.video));
    else if (event.t === "call-leave") leave(ws, rooms.get(c));
    else if (event.t === "call-decline") decline(ws, c);
    else if (event.t === "call-signal") {
      const room = rooms.get(c);
      if (room?.members.get(ws.userId) !== ws) return;
      const to = room.members.get(Number(event.to));
      if (to) live.send(to, { t: "call-signal", c, from: ws.userId, data: event.data });
    }
  }

  // Closing the tab or losing the connection leaves the call; the others
  // carry on and you can join again.
  const disconnected = (ws) => leave(ws);

  // Someone removed from a chat drops out of its call.
  function removed(c, userId) {
    const room = rooms.get(c);
    const ws = room?.members.get(userId);
    if (!ws) return;
    live.send(ws, { t: "call-left", c, reason: "removed" });
    leave(ws, room);
  }

  return { handle, disconnected, removed, view: (c) => view(rooms.get(c)) };
}
