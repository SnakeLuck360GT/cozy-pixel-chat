// The area at the top of a chat for its call and anything being watched
// together. One thing fills it (the video, a shared screen, or the other
// person), and everyone else floats on top in small windows you can drag
// anywhere; tap one to swap it into the big spot. The bottom edge drags to
// make the whole area taller or shorter. Also the "in a call" bar in the
// chat list while you're in a call.

import { api } from "/js/api.js";
import { avatar } from "/js/avatar.js";
import {
  callStats, canShareScreen, currentCall, flipCamera, joinCall, leaveCall, popOut, refreshTiles, setCamera, setFocus, tiles,
  toggleMic, toggleScreen, volumePanel,
} from "/js/calls.js";
import { $, duration, formatBytes, h, local, toast, touch } from "/js/dom.js";
import { icon } from "/js/icons.js";
import { nameOf, state, titleOf, userOf } from "/js/store.js";
import { openWindow, popover } from "/js/ui.js";
import { showWatch, startWatch, stopWatch, youTubeId } from "/js/watch.js";

let expanded = false;

export function initStage() {
  // The waiting countdown and the signal bars tick without redrawing everything.
  setInterval(() => {
    renderStatus();
    renderSignal();
  }, 1000);
  makeResizable();
}

const button = (name, label, onclick, { pressed, className = "", text } = {}) =>
  h("button", {
    class: `${text ? "btn plain" : "icon-btn"} ${className}`.trim(),
    type: "button",
    "aria-label": label,
    title: label,
    "aria-pressed": pressed === undefined ? null : String(pressed),
    onclick,
  }, icon(name, text ? "mid" : ""), text ?? null);

// Moves nodes only when something changed.
function place(box, nodes) {
  if (nodes.length === box.children.length && nodes.every((n, i) => box.children[i] === n)) return;
  box.replaceChildren(...nodes);
}

// What fills the call area, and what floats on top: a shared screen if
// someone's sharing, otherwise the other person, or a grid in a group.
function layout(room, watch) {
  const list = tiles();
  if (watch) return { main: null, floating: list };
  let main = room.focus && list.find((t) => t.key === room.focus);
  if (!main) {
    const people = [...room.peers.values()];
    const sharer = people.find((p) => p.screenTile);
    if (sharer) main = sharer.screenTile;
    else if (people.length === 1) main = people[0].tile;
    else if (!people.length) main = room.selfScreen ?? room.self;
  }
  if (!main) return { grid: list, floating: [] };
  return { main, floating: list.filter((t) => t !== main) };
}

export function renderStage() {
  const c = state.current;
  const room = currentCall();
  const here = Boolean(room && room.c === c);
  const info = c ? state.calls.get(c) : null;
  const watch = c ? state.watch.get(c) : null;
  const show = Boolean(c && (here || info || watch));
  const stage = $("stage");

  // A call in another chat keeps its tiles off-screen, still playing sound.
  if (room && !here) {
    for (const t of tiles()) t.node.classList.remove("floating");
    place($("call-dock"), tiles().map((t) => t.node));
  }
  refreshTiles();
  renderVoicePanel();

  stage.hidden = !show;
  $("convo").classList.toggle("stage-full", show && expanded);
  showWatch($("stage-watch"), c);
  if (!show) return;

  // Just an invitation to join: no need for a big area.
  const compact = !here && !watch;
  stage.classList.toggle("compact", compact);
  const saved = Number(local.get("stageHeight"));
  stage.style.height = !compact && !expanded && saved ? `${saved}px` : "";

  renderHead(c, watch, here);

  const box = $("stage-tiles");
  const float = $("stage-float");
  box.className = "stage-tiles";
  if (here) {
    const { main, grid, floating } = layout(room, watch);
    if (grid) box.classList.add("grid", `n${Math.min(grid.length, 6)}`);
    else box.classList.add("single");
    box.hidden = Boolean(watch);
    for (const t of tiles()) {
      const floats = floating.includes(t);
      t.node.classList.toggle("floating", floats);
      t.node.classList.toggle("main", t === main);
      // A window that was dragged keeps its position only while it floats.
      if (!floats) Object.assign(t.node.style, { left: "", top: "" });
      enableDrag(t);
    }
    place(box, grid ? grid.map((t) => t.node) : main ? [main.node] : []);
    place(float, floating.map((t) => t.node));
    requestAnimationFrame(() => positionFloating(floating));
  } else {
    float.replaceChildren();
    box.hidden = !info;
    if (info) {
      // A call is going here and you're not in it: who's there, and a way in.
      box.classList.add("invite");
      box.replaceChildren(
        h("div", { class: "invite-people" }, info.members.map((id) => avatar(userOf(id) ?? state.me, 40))),
        h("p", {}, `${info.members.map(nameOf).join(", ")} ${info.members.length === 1 ? "is" : "are"} in a call`),
      );
    } else {
      box.replaceChildren();
    }
  }

  renderBar(c, { room, here, info });
  renderStatus();
}

// Above the video: what's on, and how to change or stop it.
function renderHead(c, watch, here) {
  const head = $("stage-head");
  head.hidden = !watch;
  if (!watch) return;
  const items = [
    h("span", { class: "stage-title" }, icon("tv", "mid"), h("span", {}, watch.title || "Watching together")),
    button("tv", "Change the video", () => promptWatch(c), { text: "Change" }),
  ];
  // Without a call, the size button lives up here instead of in the call buttons.
  if (!here) items.push(button(expanded ? "minimize" : "expand", expanded ? "Show the chat" : "Make it bigger", toggleExpanded));
  items.push(button("close", "Stop watching together", () => stopWatch(c), { text: "Stop", className: "stop" }));
  head.replaceChildren(...items);
}

function toggleExpanded() {
  expanded = !expanded;
  renderStage();
}

function renderBar(c, { room, here, info }) {
  const items = [];
  if (here) {
    const big = tiles().find((t) => t.node.classList.contains("main") && t.user !== state.me.id);
    items.push(
      h("button", { class: "signal", id: "signal", type: "button", "aria-label": "Connection", title: "Connection", onclick: (e) => popover(e.currentTarget, statsPanel()) }),
      button(room.mic ? "mic" : "micOff", room.mic ? "Mute" : "Unmute", toggleMic, { pressed: !room.mic }),
      button(room.camera ? "video" : "videoOff", room.camera ? "Turn camera off" : "Turn camera on", () => setCamera(!room.camera), { pressed: !room.camera }),
    );
    if (touch && room.camera && !room.screen) items.push(button("flip", "Switch camera", flipCamera));
    if (canShareScreen()) items.push(button("screen", room.screen ? "Stop sharing" : "Share your screen", toggleScreen, { pressed: Boolean(room.screen) }));
    items.push(button("tv", "Watch a YouTube video together", () => promptWatch(c)));
    if (room.peers.size) items.push(h("button", { class: "icon-btn", type: "button", "aria-label": "Volume", title: "Volume", onclick: (e) => popover(e.currentTarget, volumePanel()) }, icon("volume")));
    if (document.pictureInPictureEnabled && big) {
      items.push(button("popout", "Pop the video out (keeps showing in other tabs)", () => popOut(big.key)));
    }
    items.push(
      button(expanded ? "minimize" : "expand", expanded ? "Show the chat" : "Make the call bigger", toggleExpanded, { pressed: expanded }),
      button("hangup", "Leave the call", leaveCall, { className: "danger" }),
    );
  } else if (info) {
    items.push(
      button("phone", "Join the call", () => joinCall(c, false), { text: "Join", className: "join" }),
      button("video", "Join with video", () => joinCall(c, true), { text: "With video" }),
    );
  }
  $("stage-bar").hidden = !items.length;
  $("stage-bar").replaceChildren(...items);
  renderSignal();
}

function renderStatus() {
  const node = $("stage-status");
  const room = currentCall();
  const info = room && state.calls.get(room.c);
  const waiting = room && room.c === state.current && room.joined && !room.peers.size;
  node.hidden = !waiting;
  if (!waiting) return;
  const left = info?.aloneUntil ? duration(Math.max(0, info.aloneUntil - Date.now())) : "";
  node.textContent = `Waiting for someone to join${left ? ` · the call ends in ${left} if nobody does` : ""}`;
}

// Floating windows: dragged anywhere inside the call area, remembered per
// person as a fraction of the space, so they stay put when it's resized.

function positionFloating(floating) {
  const area = $("stage-float");
  const W = area.clientWidth;
  const H = area.clientHeight;
  // Unplaced windows line up along the bottom, from the right.
  let x = W - 12;
  let y = 12;
  for (const t of floating) {
    if (t.node.classList.contains("dragging")) continue;
    const w = t.node.offsetWidth;
    const hgt = t.node.offsetHeight;
    let saved = null;
    try {
      saved = JSON.parse(local.get(`tilePos:${t.key}`));
    } catch {}
    let left;
    let top;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      left = saved.x * Math.max(0, W - w);
      top = saved.y * Math.max(0, H - hgt);
    } else {
      if (x - w < 0) {
        x = W - 12;
        y += hgt + 10;
      }
      left = x - w;
      top = H - hgt - y;
      x = left - 10;
    }
    t.node.style.left = `${Math.max(0, Math.min(left, W - w))}px`;
    t.node.style.top = `${Math.max(0, Math.min(top, H - hgt))}px`;
  }
}

function enableDrag(t) {
  if (t.dragReady) return;
  t.dragReady = true;
  const node = t.node;
  let grab = null;
  node.addEventListener("pointerdown", (e) => {
    if (!node.classList.contains("floating") || e.button > 0) return;
    e.preventDefault();
    node.setPointerCapture(e.pointerId);
    grab = { x: e.clientX, y: e.clientY, left: node.offsetLeft, top: node.offsetTop, moved: false };
  });
  node.addEventListener("pointermove", (e) => {
    if (!grab) return;
    const dx = e.clientX - grab.x;
    const dy = e.clientY - grab.y;
    if (!grab.moved && Math.hypot(dx, dy) < 5) return;
    grab.moved = true;
    node.classList.add("dragging");
    const area = $("stage-float");
    node.style.left = `${Math.max(0, Math.min(grab.left + dx, area.clientWidth - node.offsetWidth))}px`;
    node.style.top = `${Math.max(0, Math.min(grab.top + dy, area.clientHeight - node.offsetHeight))}px`;
  });
  const drop = () => {
    if (!grab) return;
    const { moved } = grab;
    grab = null;
    node.classList.remove("dragging");
    if (!moved) return currentCall() && setFocus(t.key); // A tap swaps it into the big spot.
    const area = $("stage-float");
    const x = node.offsetLeft / Math.max(1, area.clientWidth - node.offsetWidth);
    const y = node.offsetTop / Math.max(1, area.clientHeight - node.offsetHeight);
    local.set(`tilePos:${t.key}`, JSON.stringify({ x, y }));
  };
  node.addEventListener("pointerup", drop);
  node.addEventListener("pointercancel", drop);
  // Tapping the big one (or one in a grid) puts things back, or picks it.
  node.addEventListener("click", () => {
    const room = currentCall();
    if (!room || node.classList.contains("floating")) return;
    if (room.focus === t.key || !node.classList.contains("main")) setFocus(t.key);
  });
}

// Dragging the bottom edge changes how much room the call takes.
function makeResizable() {
  const handle = $("stage-resize");
  let grab = null;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    grab = { y: e.clientY, height: $("stage").offsetHeight };
  });
  handle.addEventListener("pointermove", (e) => {
    if (!grab) return;
    const max = $("convo").clientHeight - 140;
    const height = Math.max(150, Math.min(grab.height + e.clientY - grab.y, max));
    $("stage").style.height = `${height}px`;
    positionFloating(tiles().filter((t) => t.node.classList.contains("floating")));
  });
  const drop = () => {
    if (!grab) return;
    grab = null;
    local.set("stageHeight", String($("stage").offsetHeight));
  };
  handle.addEventListener("pointerup", drop);
  handle.addEventListener("pointercancel", drop);
  handle.addEventListener("dblclick", () => {
    local.set("stageHeight", "");
    $("stage").style.height = "";
  });
  addEventListener("resize", () => positionFloating(tiles().filter((t) => t.node.classList.contains("floating"))));
}

// Connection: signal bars with the ping, like Discord, and the details.

function quality(stats) {
  const people = stats.peers.filter((p) => p.rtt !== null);
  const worst = Math.max(stats.server ?? 0, ...people.map((p) => p.rtt));
  const loss = Math.max(0, ...people.map((p) => p.loss ?? 0));
  if (worst < 120 && loss < 2) return 3;
  if (worst < 300 && loss < 8) return 2;
  return 1;
}

function renderSignal() {
  const node = $("signal");
  if (!node) return;
  const stats = callStats();
  if (!stats) return;
  const bars = quality(stats);
  const ping = stats.peers.find((p) => p.rtt !== null)?.rtt ?? stats.server;
  node.className = `signal q${bars}`;
  node.replaceChildren(h("i"), h("i"), h("i"), h("span", {}, ping === null ? "…" : `${ping} ms`));
}

const kbps = (n) => (n === null ? "–" : n >= 1000 ? `${(n / 1000).toFixed(1)} Mbps` : `${n} kbps`);

// The server's own load, for admins. Shared with the admin page.
export function serverRows(s) {
  const row = (label, value) => h("div", { class: "stats-row" }, h("span", {}, label), h("strong", {}, value));
  const pct = (used, total) => `${Math.round((used / total) * 100)}%`;
  return [
    row("CPU", s.cpu === null ? "…" : `${s.cpu}% of ${s.cores} core${s.cores === 1 ? "" : "s"}`),
    row("Load (1, 5, 15 min)", s.load.join(" · ")),
    row("Memory", `${formatBytes(s.memory.used)} of ${formatBytes(s.memory.total)} (${pct(s.memory.used, s.memory.total)})`),
    row("Disk", `${formatBytes(s.disk.used)} of ${formatBytes(s.disk.total)} (${pct(s.disk.used, s.disk.total)})`),
    row("Network", s.network.inBps === null ? "…" : `${formatBytes(s.network.inBps)}/s in · ${formatBytes(s.network.outBps)}/s out`),
    row("Chat app", `${formatBytes(s.app.memory)} memory · up ${duration(s.app.uptime * 1000)}`),
    row("Server up for", duration(s.uptime * 1000)),
  ];
}

function statsPanel() {
  const panel = h("div", { class: "stats-panel" });
  let system = null;
  const loadSystem = () => state.me.admin && api("/api/admin/system").then((s) => (system = s)).catch(() => {});
  loadSystem();
  let ticks = 0;
  const draw = () => {
    if (++ticks % 2 === 0) loadSystem();
    const stats = callStats();
    if (!stats) return;
    const row = (label, value) => h("div", { class: "stats-row" }, h("span", {}, label), h("strong", {}, value));
    const rows = [
      h("h3", {}, "Connection"),
      row("Ping to the server", stats.server === null ? "…" : `${stats.server} ms`),
      ...stats.peers.flatMap((p) => [
        h("h4", {}, nameOf(p.user)),
        row("Ping", p.rtt === null ? "Connecting…" : `${p.rtt} ms`),
        row("Route", p.route),
        row("Packet loss", p.loss === null ? "–" : `${p.loss}%`),
        row("Receiving", `${kbps(p.inKbps)}${p.inVideo ? ` · ${p.inVideo}` : ""}`),
        row("Sending", `${kbps(p.outKbps)}${p.outVideo ? ` · ${p.outVideo}` : ""}`),
      ]),
    ];
    if (!stats.peers.length) rows.push(h("p", { class: "dim" }, "Nobody else is in the call yet."));
    if (system) rows.push(h("h4", {}, "Server"), ...serverRows(system));
    panel.replaceChildren(...rows);
  };
  draw();
  const timer = setInterval(() => (panel.isConnected ? draw() : clearInterval(timer)), 1000);
  return panel;
}

// The bar under the chat list while you're in a call, wherever you are.
function renderVoicePanel() {
  const panel = $("voice-panel");
  const room = currentCall();
  const conv = room && state.conversations.get(room.c);
  // Hidden while you're looking at that chat, since its call is right there.
  panel.hidden = !conv || (room.c === state.current && $("app").classList.contains("in-chat"));
  if (panel.hidden) return;
  panel.replaceChildren(
    h("a", { class: "voice-where", href: `#/c/${room.c}` },
      h("strong", {}, room.peers.size ? "In a call" : "Waiting in a call"),
      h("span", {}, titleOf(conv)),
    ),
    button(room.mic ? "mic" : "micOff", room.mic ? "Mute" : "Unmute", toggleMic, { pressed: !room.mic }),
    button("hangup", "Leave the call", leaveCall, { className: "danger" }),
  );
}

export function promptWatch(c) {
  const input = h("input", { type: "url", placeholder: "https://youtube.com/watch?v=…", autocomplete: "off", required: true });
  const form = h("form", {},
    h("p", { class: "dim" }, "Paste a YouTube link. Everyone in the chat sees it, and play, pause and skipping stay in step."),
    h("label", { class: "field" }, h("span", {}, "YouTube link"), input),
    h("div", { class: "actions" },
      state.watch.get(c) ? h("button", { class: "btn plain", type: "button", onclick: () => {
        stopWatch(c);
        dialog.close();
      } }, "Stop watching") : null,
      h("button", { class: "btn", type: "submit" }, "Watch"),
    ),
  );
  const dialog = openWindow({ title: "Watch together", body: form });
  form.onsubmit = (e) => {
    e.preventDefault();
    const videoId = youTubeId(input.value);
    if (!videoId) return toast("That doesn't look like a YouTube link", true);
    startWatch(c, videoId);
    dialog.close();
  };
  input.focus();
}
