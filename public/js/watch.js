// Watching YouTube together: one video per chat, kept in step for everyone
// in it. Anyone can play, pause or skip and the others follow. The player is
// YouTube's privacy-friendly embed (youtube-nocookie.com), driven by messages
// to its frame, so none of YouTube's scripts run inside the app itself.

import { h } from "/js/dom.js";
import * as socket from "/js/socket.js";
import { emit, state } from "/js/store.js";

const YT = "https://www.youtube-nocookie.com";
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;

let player = null;
// Server clock minus ours, so "where should it be now" agrees across devices.
let offset = 0;

export function youTubeId(text) {
  const match = String(text ?? "").match(/(?:youtube\.com\/(?:watch\?(?:\S*?&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return match?.[1] ?? null;
}

export function setWatch(c, watch, now) {
  if (now) offset = now - Date.now();
  if (watch) state.watch.set(c, watch);
  else state.watch.delete(c);
}

export function initWatch() {
  socket.on("watch", ({ c, watch, now }) => {
    setWatch(c, watch, now);
    emit("watch");
  });
  addEventListener("message", onMessage);
  // Every few seconds, nudge back into step if this player has drifted.
  setInterval(() => {
    const w = player && state.watch.get(player.c);
    if (w?.playing && player.ready && player.state === PLAYING && Math.abs(player.time - expected(w)) > 2) sync();
  }, 3000);
}

export const startWatch = (c, videoId) => socket.send({ t: "watch-start", c, videoId });
export const stopWatch = (c) => socket.send({ t: "watch-stop", c });

const expected = (w) => w.position + (w.playing ? Math.max(0, (Date.now() + offset - w.at) / 1000) : 0);

// Shows the chat's video in `box`, or clears it. The frame is only made
// again when the video changes, so playback isn't interrupted.
export function showWatch(box, c) {
  const w = state.watch.get(c);
  if (!w) {
    destroy();
    box.replaceChildren();
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (!player || player.c !== c || player.videoId !== w.videoId || !box.contains(player.frame)) create(box, c, w);
  else sync();
}

function destroy() {
  clearTimeout(player?.nudge);
  player?.frame.remove();
  player = null;
}

function create(box, c, w) {
  destroy();
  const start = Math.floor(expected(w));
  const frame = h("iframe", {
    src: `${YT}/embed/${w.videoId}?enablejsapi=1&playsinline=1&rel=0&start=${start}&origin=${encodeURIComponent(location.origin)}`,
    title: "YouTube video",
    allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
    allowfullscreen: true,
    // YouTube refuses to play embeds that don't say which site they're on.
    referrerpolicy: "strict-origin-when-cross-origin",
  });
  const resume = h("button", { class: "btn watch-resume", type: "button", hidden: true }, "Tap to join in");
  player = { c, videoId: w.videoId, frame, resume, ready: false, state: -1, time: start, timeAt: null, quietUntil: 0 };
  resume.onclick = () => {
    resume.hidden = true;
    command("playVideo");
  };
  box.replaceChildren(frame, resume);
  // The frame starts talking once it's been told someone is listening.
  frame.addEventListener("load", () => {
    const hello = setInterval(() => {
      if (player?.frame !== frame || player.ready) return clearInterval(hello);
      post("listening");
    }, 250);
  });
}

function post(event, extra = {}) {
  player?.frame.contentWindow?.postMessage(JSON.stringify({ event, id: 1, channel: "widget", ...extra }), YT);
}

const command = (func, args = []) => post("command", { func, args });

function onMessage(e) {
  if (!player || e.origin !== YT || e.source !== player.frame.contentWindow) return;
  let data;
  try {
    data = JSON.parse(e.data);
  } catch {
    return;
  }
  if ((data.event === "onReady" || data.event === "initialDelivery") && !player.ready) {
    player.ready = true;
    command("addEventListener", ["onStateChange"]);
    sync(true);
  }
  const info = data.info;
  if (data.event === "infoDelivery" && info) {
    if (typeof info.currentTime === "number") onTime(info.currentTime);
    if (typeof info.playerState === "number") onState(info.playerState);
  }
  if (data.event === "onStateChange" && typeof info === "number") onState(info);
}

// Our own commands cause state changes too; those are ignored for a moment
// so they aren't sent back out as if someone had pressed something.
const quiet = () => Date.now() < player.quietUntil;

function onState(s) {
  if (s === player.state) return;
  player.state = s;
  if (s === PLAYING) player.resume.hidden = true;
  const w = state.watch.get(player.c);
  if (!w || quiet()) return;
  if (s === PLAYING && !w.playing) report(true);
  else if (s === PAUSED && w.playing) report(false);
}

function onTime(t) {
  const now = Date.now();
  const before = player.time;
  const beforeAt = player.timeAt;
  player.time = t;
  player.timeAt = now;
  const w = state.watch.get(player.c);
  if (!w || beforeAt === null || quiet() || player.state === BUFFERING) return;
  // A jump the clock can't explain is someone dragging the progress bar.
  const jump = t - (before + (player.state === PLAYING ? (now - beforeAt) / 1000 : 0));
  if (Math.abs(jump) > 2) report(player.state === PLAYING);
}

function report(playing) {
  const w = state.watch.get(player.c);
  Object.assign(w, { playing, position: player.time, at: Date.now() + offset });
  socket.send({ t: "watch-state", c: player.c, videoId: player.videoId, playing, position: player.time });
}

function sync(force = false) {
  const w = player && state.watch.get(player.c);
  if (!w || !player.ready) return;
  const target = expected(w);
  player.quietUntil = Date.now() + 1500;
  if (force || Math.abs(player.time - target) > 1.5) {
    command("seekTo", [target, true]);
    player.time = target;
    player.timeAt = Date.now();
  }
  if (w.playing && player.state !== PLAYING && player.state !== BUFFERING) {
    command("playVideo");
    // Browsers sometimes block a video from starting on its own; offer a button.
    clearTimeout(player.nudge);
    const current = player;
    player.nudge = setTimeout(() => {
      if (player === current && state.watch.get(current.c)?.playing && current.state !== PLAYING && current.state !== BUFFERING) current.resume.hidden = false;
    }, 2500);
  }
  if (!w.playing && player.state === PLAYING) command("pauseVideo");
}
