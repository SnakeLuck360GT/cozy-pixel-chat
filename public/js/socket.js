// The live connection. Reconnects on its own with a growing delay, and
// tells listeners when it's back so they can catch up on what they missed.

import { toLogin } from "/js/api.js";

const listeners = new Map();
let ws = null;
let attempts = 0;

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
}

function emit(type, event) {
  for (const fn of listeners.get(type) ?? []) {
    try {
      fn(event);
    } catch (err) {
      console.error(err);
    }
  }
}

export function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    attempts = 0;
    emit("open");
  };
  ws.onmessage = (e) => {
    let event;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }
    emit(event.t, event);
  };
  ws.onclose = async (e) => {
    emit("close");
    if (e.code === 4001) return toLogin();
    // A refused connection looks the same as a dropped one; check the
    // session is still good before trying again.
    if (attempts > 1) {
      const res = await fetch("/api/me").catch(() => null);
      if (res?.status === 401) return toLogin();
    }
    setTimeout(connect, Math.min(15_000, 600 * 2 ** attempts++));
  };
}

export function send(event) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(event));
  return true;
}

export const connected = () => ws?.readyState === WebSocket.OPEN;
