// Calls, Discord-style: each chat can have a call going. Starting one rings
// the others, and anyone in the chat can join, leave and rejoin while it's
// open. Audio and video go directly between browsers (WebRTC), through the
// TURN relay when they can't reach each other. With more than two people,
// every pair connects directly, which is fine for a handful.
//
// This module owns the connections and the tiles: one per person, plus one
// for each shared screen (sent as its own video, so faces stay visible while
// someone shares). stage.js decides where the tiles and buttons are shown.

import { api } from "/js/api.js";
import { avatar } from "/js/avatar.js";
import { h, local, toast, touch } from "/js/dom.js";
import { icon } from "/js/icons.js";
import * as socket from "/js/socket.js";
import { play, startRinging, stopRinging } from "/js/sound.js";
import { emit, nameOf, state, titleOf, userOf } from "/js/store.js";

let room = null;
let ringing = null;

export const currentCall = () => room;

const LEFT = {
  alone: "Nobody else was in the call, so it ended",
  elsewhere: "You joined this call on another device",
  declined: "They declined the call",
  removed: "You were removed from the group",
  dropped: "Your connection dropped, so you left the call. Join again from the chat.",
};

export function initCalls() {
  socket.on("call-room", ({ c, room: info }) => {
    if (info) state.calls.set(c, info);
    else state.calls.delete(c);
    emit("calls");
  });
  socket.on("call-ring", showRing);
  socket.on("call-ring-stop", ({ c }) => ringing?.c === c && dismissRing());
  socket.on("call-joined", ({ c, peers }) => {
    if (room?.c !== c) return;
    room.joined = true;
    for (const id of peers) addPeer(id, false);
    emit("calls");
  });
  socket.on("call-peer-joined", ({ c, user }) => {
    if (room?.c !== c) return;
    addPeer(user, true);
    play("message", true);
    emit("calls");
  });
  socket.on("call-peer-left", ({ c, user }) => {
    if (room?.c !== c) return;
    removePeer(user);
    play("hangup", true);
    emit("calls");
  });
  socket.on("call-signal", ({ c, from, data }) => {
    if (room?.c !== c) return;
    let peer = room.peers.get(from);
    if (!peer && data?.description?.type === "offer") peer = addPeer(from, true);
    if (!peer) return;
    peer.queue = peer.queue.then(() => room?.peers.get(from) === peer && onSignal(peer, data)).catch(console.error);
  });
  socket.on("call-left", ({ c, reason }) => {
    if (room?.c !== c) return;
    cleanup();
    toast(LEFT[reason] ?? "You left the call");
  });
  socket.on("error", ({ error }) => {
    if (room && !room.joined) {
      cleanup();
      toast(error, true);
    }
  });
  // The server drops you from calls when the connection goes.
  socket.on("close", () => {
    if (!room) return;
    cleanup();
    toast(LEFT.dropped, true);
  });

  // Any tap wakes the audio mixer if the browser paused it.
  addEventListener("pointerdown", () => room?.audio?.ctx.state === "suspended" && room.audio.ctx.resume(), true);
  // Leaving the page leaves the call properly rather than leaving people waiting.
  addEventListener("pagehide", () => room && socket.send({ t: "call-leave", c: room.c }));
  setInterval(meters, 150);
  setInterval(sampleStats, 2000);
  socket.on("pong", ({ id }) => {
    if (room && id) serverPing = Math.round(performance.now() - id);
  });
}

// Connection stats, like Discord's: ping to the server, and per person the
// ping, whether it's direct or relayed, packet loss and how much is flowing.

let serverPing = null;

async function sampleStats() {
  if (!room) return;
  socket.send({ t: "ping", id: performance.now() });
  for (const peer of room.peers.values()) {
    const report = await peer.pc.getStats().catch(() => null);
    if (!report || !room) continue;
    let pairId = null;
    let inBytes = 0;
    let outBytes = 0;
    let lost = 0;
    let received = 0;
    let inVideo = null;
    let outVideo = null;
    const video = (s) => (s.frameWidth ? `${s.frameWidth}×${s.frameHeight} ${Math.round(s.framesPerSecond ?? 0)} fps` : null);
    report.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      if (s.type === "inbound-rtp") {
        inBytes += s.bytesReceived ?? 0;
        lost += s.packetsLost ?? 0;
        received += s.packetsReceived ?? 0;
        if (s.kind === "video") inVideo = video(s) ?? inVideo;
      }
      if (s.type === "outbound-rtp") {
        outBytes += s.bytesSent ?? 0;
        if (s.kind === "video") outVideo = video(s) ?? outVideo;
      }
    });
    let pair = pairId && report.get(pairId);
    if (!pair) report.forEach((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded" && (pair = s));
    const local = pair && report.get(pair.localCandidateId);
    const remote = pair && report.get(pair.remoteCandidateId);
    let route = "Connecting…";
    if (pair) {
      if (local?.candidateType === "relay" || remote?.candidateType === "relay") route = "Through the relay server";
      else if (local?.candidateType === "host" && remote?.candidateType === "host") route = "Direct, same network";
      else route = "Direct";
    }
    const now = performance.now();
    const before = peer.sample;
    const seconds = before ? (now - before.at) / 1000 : 0;
    const newLost = before ? lost - before.lost : 0;
    const newReceived = before ? received - before.received : 0;
    peer.sample = { at: now, inBytes, outBytes, lost, received };
    peer.stats = {
      rtt: pair?.currentRoundTripTime !== undefined ? Math.round(pair.currentRoundTripTime * 1000) : null,
      route,
      loss: before && newLost + newReceived > 0 ? Math.round((Math.max(0, newLost) / (newLost + newReceived)) * 1000) / 10 : null,
      inKbps: seconds ? Math.round(((inBytes - before.inBytes) * 8) / seconds / 1000) : null,
      outKbps: seconds ? Math.round(((outBytes - before.outBytes) * 8) / seconds / 1000) : null,
      inVideo,
      outVideo,
    };
  }
}

export function callStats() {
  if (!room) return null;
  return {
    server: serverPing,
    peers: [...room.peers.values()].map((p) => ({
      user: p.user,
      rtt: p.stats?.rtt ?? null,
      route: p.stats?.route ?? "Connecting…",
      loss: p.stats?.loss ?? null,
      inKbps: p.stats?.inKbps ?? null,
      outKbps: p.stats?.outKbps ?? null,
      inVideo: p.stats?.inVideo ?? null,
      outVideo: p.stats?.outVideo ?? null,
    })),
  };
}

// Joining and leaving

// Says what actually went wrong, so it can be fixed.
function deviceProblem(err, what) {
  if (!navigator.mediaDevices) return "This browser can't use the camera or microphone here. Open the site in Safari or Chrome.";
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return `The ${what} is blocked for this site. Allow it in the browser's site settings (the icon next to the address), then try again.`;
    case "NotReadableError":
    case "AbortError":
      return `The ${what} is busy. Close other apps or tabs using it (FaceTime, Zoom, another call) and try again.`;
    case "NotFoundError":
    case "OverconstrainedError":
      return `No ${what} was found on this device.`;
    default:
      return `Couldn't start the ${what}${err?.name ? ` (${err.name})` : ""}.`;
  }
}

// Asks for the camera with nice settings first, then plainly, since some
// cameras turn down the first request.
async function camera(facing) {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") throw err;
    return navigator.mediaDevices.getUserMedia({ video: true });
  }
}

async function media(video) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (video) {
      // Without a camera you still join, just with your voice.
      try {
        for (const track of (await camera("user")).getVideoTracks()) stream.addTrack(track);
      } catch (err) {
        toast(deviceProblem(err, "camera"), true);
      }
    }
    return stream;
  } catch (err) {
    toast(deviceProblem(err, "microphone"), true);
    return null;
  }
}

// The audio mixer has to be made straight after a tap, or the browser
// keeps it paused (and the mic would go silent), so it's made first.
function newAudioContext() {
  try {
    const ctx = new AudioContext();
    ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

const volumeSetting = (key) => {
  const raw = local.get(key);
  const value = Number(raw);
  return raw !== null && Number.isFinite(value) ? Math.min(300, Math.max(0, value)) : 100;
};

// Your mic goes through a volume control (with boost) before it's sent.
// If the browser can't do that, the mic is sent as it is.
function withMicVolume(raw, ctx) {
  if (!ctx) return { stream: raw, audio: null };
  try {
    const gain = ctx.createGain();
    gain.gain.value = volumeSetting("micVolume") / 100;
    const out = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(new MediaStream(raw.getAudioTracks())).connect(gain).connect(out);
    return { stream: new MediaStream([...out.stream.getAudioTracks(), ...raw.getVideoTracks()]), audio: { ctx, micGain: gain, raw } };
  } catch {
    return { stream: raw, audio: null };
  }
}

export async function joinCall(c, video) {
  if (room?.c === c) return;
  if (!socket.connected()) return toast("Reconnecting… try again in a moment", true);
  if (room) leaveCall();
  const ctx = newAudioContext();
  const stream = await media(video);
  if (!stream) return ctx?.close();
  let iceServers;
  try {
    ({ iceServers } = await api("/api/ice"));
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    ctx?.close();
    return toast(err.message, true);
  }
  if (room) leaveCall();
  dismissRing();
  room = {
    c,
    joined: false,
    iceServers,
    ...withMicVolume(stream, ctx),
    peers: new Map(),
    mic: true,
    camera: stream.getVideoTracks().length > 0,
    screen: null,
    facing: "user",
    focus: null,
  };
  room.self = makeTile(String(state.me.id), state.me.id, null);
  watchCamera(room.stream.getVideoTracks()[0]);
  socket.send({ t: "call-join", c, video });
  emit("calls");
}

export function leaveCall() {
  if (!room) return;
  socket.send({ t: "call-leave", c: room.c });
  cleanup();
}

function cleanup() {
  if (!room) return;
  for (const peer of room.peers.values()) peer.pc.close();
  room.stream.getTracks().forEach((t) => t.stop());
  room.audio?.raw.getTracks().forEach((t) => t.stop());
  room.screen?.stop();
  room.audio?.ctx.close().catch(() => {});
  for (const tile of tiles()) tile.node.remove();
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  room = null;
  serverPing = null;
  play("hangup", true);
  emit("calls");
}

// Ringing

function showRing({ c, from, video }) {
  if (room?.c === c) return;
  dismissRing();
  const conv = state.conversations.get(c);
  const where = conv?.kind === "group" ? ` in ${titleOf(conv)}` : "";
  const accept = h("button", { class: "icon-btn accept", type: "button", "aria-label": "Join the call" }, icon(video ? "video" : "phone"));
  const decline = h("button", { class: "icon-btn danger", type: "button", "aria-label": "Decline" }, icon("hangup"));
  const node = h("div", { class: "incoming window", role: "alertdialog", "aria-label": "Incoming call" },
    avatar(userOf(from), 56),
    h("span", {}, h("strong", {}, nameOf(from)), h("small", {}, `${video ? "Video" : "Voice"} call${where}`)),
    decline, accept,
  );
  ringing = { c, node };
  document.body.append(node);
  startRinging();
  if (document.hidden && local.get("notify") === "on" && window.Notification?.permission === "granted") {
    new Notification(nameOf(from), { body: `${video ? "Video" : "Voice"} call${where}`, tag: `call-${c}` });
  }
  decline.onclick = () => {
    socket.send({ t: "call-decline", c });
    dismissRing();
  };
  accept.onclick = () => {
    location.hash = `#/c/${c}`;
    joinCall(c, video);
  };
}

function dismissRing() {
  stopRinging();
  ringing?.node.remove();
  ringing = null;
}

// Connections, one per other person. "Perfect negotiation": either side may
// start a new offer (say, turning a camera on mid-call). Whoever joined
// last offers first, and the other side gives way if both do at once.

function addPeer(userId, polite) {
  removePeer(userId);
  const pc = new RTCPeerConnection({ iceServers: room.iceServers });
  const peer = {
    user: userId,
    pc,
    polite,
    makingOffer: false,
    ignoreOffer: false,
    tracksAdded: false,
    queue: Promise.resolve(),
    // Their incoming streams by id: one with their mic and camera, and one
    // for their screen while they share it.
    streams: new Map(),
    // What their tile plays: their sound and their newest camera video,
    // gathered from whichever streams they arrived in.
    view: new MediaStream(),
    screenSender: null,
    cameraTransceiver: null,
    state: { camera: false, mic: true, screen: false, screenStream: null },
    volume: volumeSetting(`voiceVolume:${userId}`),
  };
  room.peers.set(userId, peer);
  peer.tile = makeTile(String(userId), userId, peer);
  const signal = (data) => socket.send({ t: "call-signal", c: room.c, to: userId, data });
  peer.signal = signal;

  pc.onicecandidate = ({ candidate }) => candidate && signal({ candidate: candidate.toJSON() });
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      signal({ description: pc.localDescription.toJSON() });
    } catch (err) {
      console.error(err);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0] ?? new MediaStream([track]);
    peer.streams.set(stream.id, stream);
    stream.onaddtrack = () => emit("calls");
    stream.onremovetrack = () => emit("calls");
    track.onmute = refreshTiles;
    track.onunmute = refreshTiles;
    track.onended = () => emit("calls");
    if (track.kind === "audio") listen(peer.tile, new MediaStream([track]));
    emit("calls");
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      sendState(peer);
      tuneVideo();
    }
    if (pc.connectionState === "failed") pc.restartIce();
    refreshTiles();
  };
  if (!polite) addTracks(peer);
  return peer;
}

function removePeer(userId) {
  const peer = room?.peers.get(userId);
  if (!peer) return;
  peer.pc.close();
  peer.tile.node.remove();
  peer.screenTile?.node.remove();
  room.peers.delete(userId);
  if (room.focus === String(userId) || room.focus === `s:${userId}`) room.focus = null;
}

function addTracks(peer) {
  if (peer.tracksAdded) return;
  peer.tracksAdded = true;
  for (const track of room.stream.getAudioTracks()) peer.pc.addTrack(track, room.stream);
  const camera = room.camera ? room.stream.getVideoTracks()[0] : null;
  if (camera) peer.cameraTransceiver = transceiverOf(peer, peer.pc.addTrack(camera, room.stream));
  if (room.screen) peer.screenSender = peer.pc.addTrack(room.screen, room.screenStream);
}

const transceiverOf = (peer, sender) => peer.pc.getTransceivers().find((t) => t.sender === sender) ?? null;

const screenStreamOf = (peer) => (peer.state.screenStream && peer.streams.get(peer.state.screenStream)) || null;

// Their sound and camera: every live track that isn't part of their shared
// screen, kept in their tile's stream. Browsers don't always group them the
// same way, so this doesn't rely on which stream they came in.
function cameraStreamOf(peer) {
  const tracks = [...peer.streams.values()]
    .filter((s) => s.id !== peer.state.screenStream)
    .flatMap((s) => s.getTracks())
    .filter((t) => t.readyState === "live");
  const wanted = [...tracks.filter((t) => t.kind === "audio"), ...tracks.filter((t) => t.kind === "video").slice(-1)];
  for (const t of peer.view.getTracks()) if (!wanted.includes(t)) peer.view.removeTrack(t);
  for (const t of wanted) if (!peer.view.getTracks().includes(t)) peer.view.addTrack(t);
  return peer.view;
}

async function onSignal(peer, data) {
  const pc = peer.pc;
  if (data.description) {
    const collision = data.description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    await pc.setRemoteDescription(data.description);
    if (data.description.type === "offer") {
      addTracks(peer);
      await pc.setLocalDescription();
      peer.signal({ description: pc.localDescription.toJSON() });
    }
  } else if (data.candidate) {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      if (!peer.ignoreOffer) throw err;
    }
  } else if (data.state) {
    const before = peer.state.screen;
    const screenStream = typeof data.state.screenStream === "string" ? data.state.screenStream : null;
    peer.state = { camera: Boolean(data.state.camera), mic: Boolean(data.state.mic), screen: Boolean(data.state.screen), screenStream };
    // Someone starting to share their screen gets the big spot.
    if (peer.state.screen && !before) room.focus = null;
    emit("calls");
  }
}

function sendState(only) {
  if (!room) return;
  // Phones pause the camera in the background (the track goes "muted");
  // computers can report that briefly while a webcam starts, so they're trusted.
  const track = room.stream.getVideoTracks()[0];
  const cameraLive = room.camera && track?.readyState === "live" && !(touch && track.muted);
  const data = { state: { camera: Boolean(cameraLive), mic: room.mic, screen: Boolean(room.screen), screenStream: room.screenStream?.id ?? null } };
  for (const peer of only ? [only] : room.peers.values()) peer.signal(data);
}

// Puts the camera (or nothing) in each connection's camera slot, making
// one the first time it's needed.
async function sendCamera(track) {
  for (const peer of room.peers.values()) {
    if (!peer.tracksAdded) continue;
    const transceiver = peer.cameraTransceiver;
    if (transceiver && !transceiver.stopped) {
      // Changing direction renegotiates if needed.
      if (track && transceiver.direction !== "sendrecv") transceiver.direction = "sendrecv";
      await transceiver.sender.replaceTrack(track);
    } else if (track) {
      peer.cameraTransceiver = transceiverOf(peer, peer.pc.addTrack(track, room.stream));
    }
  }
}

// More bandwidth for a shared screen than for a face. Tried again shortly
// after, in case a video slot was still being set up.
function tuneVideo() {
  const apply = async () => {
    if (!room) return;
    for (const peer of room.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track?.kind !== "video") continue;
        const params = sender.getParameters();
        if (!params.encodings?.length) continue;
        // The camera gives way a little while a screen is being shared.
        const screen = sender.track === room.screen;
        params.encodings[0].maxBitrate = screen ? 6_000_000 : room.screen ? 1_000_000 : 2_500_000;
        params.encodings[0].maxFramerate = 30;
        try {
          await sender.setParameters(params);
        } catch {}
      }
    }
  };
  apply();
  setTimeout(apply, 1500);
}

// Phones pause the camera when the browser goes to the background; tell the
// others so they see your picture instead of a frozen frame.
function watchCamera(track) {
  if (!track) return;
  track.onmute = () => sendState();
  track.onunmute = () => sendState();
}

// Controls, used by stage.js and the "voice connected" bar.

export function toggleMic() {
  room.mic = !room.mic;
  for (const t of room.stream.getAudioTracks()) t.enabled = room.mic;
  sendState();
  emit("calls");
}

export async function setCamera(on, facing = room.facing) {
  const old = room.stream.getVideoTracks()[0];
  let track = null;
  if (on) {
    try {
      track = (await camera(facing)).getVideoTracks()[0];
    } catch (err) {
      return toast(deviceProblem(err, "camera"), true);
    }
  }
  if (!room) return track?.stop();
  if (old) {
    old.stop();
    room.stream.removeTrack(old);
  }
  if (track) {
    room.stream.addTrack(track);
    watchCamera(track);
  }
  room.camera = on;
  room.facing = facing;
  await sendCamera(track);
  tuneVideo();
  sendState();
  emit("calls");
}

export const flipCamera = () => setCamera(true, room.facing === "user" ? "environment" : "user");

export const canShareScreen = () => Boolean(navigator.mediaDevices?.getDisplayMedia) && !touch;

export async function toggleScreen() {
  if (room.screen) return stopScreen();
  let stream;
  try {
    // Capped at 1080p: a full-resolution Retina screen is more than the
    // browser can compress live, and it ends up dropping frames.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 30, max: 30 } },
      audio: false,
    });
  } catch {
    return; // Cancelled in the browser's picker.
  }
  if (!room) return stream.getTracks().forEach((t) => t.stop());
  const track = stream.getVideoTracks()[0];
  // Smoothness over sharpness: when bandwidth runs short, lower the
  // quality rather than the frame rate.
  track.contentHint = "motion";
  // The browser's own "Stop sharing" button ends the track.
  track.onended = () => room?.screen === track && stopScreen();
  room.screen = track;
  room.screenStream = new MediaStream([track]);
  room.selfScreen = makeTile("s:me", state.me.id, null, true);
  for (const peer of room.peers.values()) {
    if (peer.tracksAdded) peer.screenSender = peer.pc.addTrack(track, room.screenStream);
  }
  tuneVideo();
  sendState();
  emit("calls");
}

async function stopScreen() {
  const track = room.screen;
  room.screen = null;
  room.screenStream = null;
  track.stop();
  for (const peer of room.peers.values()) {
    if (!peer.screenSender) continue;
    try {
      peer.pc.removeTrack(peer.screenSender);
    } catch {}
    peer.screenSender = null;
  }
  room.selfScreen?.node.remove();
  room.selfScreen = null;
  if (room.focus === "s:me") room.focus = null;
  tuneVideo();
  sendState();
  emit("calls");
}

export async function popOut(key) {
  const video = tiles().find((t) => t.key === key)?.video;
  if (!video) return;
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch {
    toast("Your browser can't pop the video out", true);
  }
}

export function setFocus(key) {
  room.focus = room.focus === key ? null : key;
  emit("calls");
}

// Volume. Someone's voice up to 100% just sets their player's volume.
// Boosting past 100% goes through the browser's audio mixer instead, where
// some browsers can't cancel echo, so headphones are best for that.
function applyVolume(peer) {
  const video = peer.tile.video;
  const level = peer.volume / 100;
  if (level <= 1 || !room.audio) {
    if (peer.gain) peer.gain.gain.value = 0;
    video.muted = false;
    video.volume = Math.min(1, level);
    return;
  }
  const track = cameraStreamOf(peer)?.getAudioTracks()[0];
  if (!peer.gain && track) {
    const { ctx } = room.audio;
    peer.gain = ctx.createGain();
    ctx.createMediaStreamSource(new MediaStream([track])).connect(peer.gain).connect(ctx.destination);
    ctx.resume();
  }
  if (!peer.gain) return;
  peer.gain.gain.value = level;
  video.muted = true;
}

export function volumePanel() {
  const slider = (label, key, value, apply) => {
    const out = h("output", {}, `${value}%`);
    const input = h("input", { type: "range", min: "0", max: "300", step: "10", value: String(value), "aria-label": label });
    input.oninput = () => {
      out.textContent = `${input.value}%`;
      local.set(key, input.value);
      apply(Number(input.value));
    };
    return h("label", { class: "volume-row" }, h("span", {}, label, out), input);
  };
  return h("div", { class: "volume-panel" },
    [...room.peers.values()].map((peer) => slider(`${nameOf(peer.user)}'s voice`, `voiceVolume:${peer.user}`, peer.volume, (v) => {
      peer.volume = v;
      applyVolume(peer);
    })),
    room.audio ? slider("Your mic", "micVolume", Math.round(room.audio.micGain.gain.value * 100), (v) => {
      room.audio.micGain.gain.value = v / 100;
    }) : null,
    h("small", {}, "Past 100% is a boost. Boosting someone's voice works best with headphones, or they may hear an echo."),
  );
}

// Tiles: one per person, with their video or their picture, a name, a muted
// badge, and a green edge while they're talking.

// key is the person's id, or "s:<id>" for a shared screen ("s:me" for yours).
function makeTile(key, userId, peer, screen = false) {
  const video = h("video", { autoplay: true, playsinline: true });
  // Sound only ever plays from the other person's camera tile.
  if (!peer || screen) video.muted = true;
  const who = peer ? nameOf(userId) : "You";
  const node = h("div", { class: `tile${peer ? "" : " self"}${screen ? " screen" : ""}`, dataset: { key } },
    video,
    h("div", { class: "tile-face" }, avatar(userOf(userId) ?? state.me, 56)),
    h("span", { class: "tile-name" }, screen ? (peer ? `${who}'s screen` : "Your screen") : who, h("span", { class: "tile-muted", hidden: true }, icon("micOff", "small"))),
  );
  const tile = { key, user: userId, node, video, screen };
  if (!peer && !screen && room?.audio) listen(tile, new MediaStream(room.audio.raw.getAudioTracks()));
  return tile;
}

// A level meter per person, for the "talking" edge.
function listen(tile, stream) {
  if (!room?.audio || tile.analyser) return;
  try {
    tile.analyser = room.audio.ctx.createAnalyser();
    tile.analyser.fftSize = 512;
    room.audio.ctx.createMediaStreamSource(stream).connect(tile.analyser);
    tile.samples = new Float32Array(tile.analyser.fftSize);
  } catch {
    tile.analyser = null;
  }
}

function meters() {
  if (!room) return;
  for (const tile of tiles()) {
    if (!tile.analyser) continue;
    tile.analyser.getFloatTimeDomainData(tile.samples);
    let sum = 0;
    for (const s of tile.samples) sum += s * s;
    const level = Math.sqrt(sum / tile.samples.length);
    const muted = tile === room.self ? !room.mic : !room.peers.get(tile.user)?.state.mic;
    tile.node.classList.toggle("speaking", level > 0.02 && !muted);
  }
}

export function tiles() {
  if (!room) return [];
  const list = [room.self];
  if (room.selfScreen) list.push(room.selfScreen);
  for (const peer of room.peers.values()) {
    list.push(peer.tile);
    if (peer.screenTile) list.push(peer.screenTile);
  }
  return list;
}

// Brings every tile up to date: video or picture, mirrored or not, muted
// badge, and screen tiles appearing and going as people share.
export function refreshTiles() {
  if (!room) return;
  const self = room.self;
  if (self.video.srcObject !== room.stream) self.video.srcObject = room.stream;
  self.node.classList.toggle("has-video", Boolean(room.camera));
  self.node.classList.toggle("mirror", room.camera && room.facing === "user");
  self.node.querySelector(".tile-muted").hidden = room.mic;
  if (room.selfScreen) {
    if (room.selfScreen.video.srcObject !== room.screenStream) room.selfScreen.video.srcObject = room.screenStream;
    room.selfScreen.node.classList.add("has-video");
  }

  for (const peer of room.peers.values()) {
    const camera = cameraStreamOf(peer);
    if (peer.tile.video.srcObject !== camera) {
      peer.tile.video.srcObject = camera;
      applyVolume(peer);
    }
    // Their video shows whenever they say their camera's on and video is
    // coming in; "muted" isn't trusted here, as some browsers leave it set.
    const live = camera.getVideoTracks().length > 0;
    peer.tile.node.classList.toggle("has-video", live && peer.state.camera);
    peer.tile.node.classList.toggle("connecting", peer.pc.connectionState !== "connected");
    peer.tile.node.querySelector(".tile-muted").hidden = peer.state.mic;
    peer.tile.video.play?.().catch(() => {});

    const screen = peer.state.screen ? screenStreamOf(peer) : null;
    const showing = screen?.getVideoTracks().some((t) => t.readyState === "live");
    if (showing && !peer.screenTile) peer.screenTile = makeTile(`s:${peer.user}`, peer.user, peer, true);
    if (!showing && peer.screenTile) {
      peer.screenTile.node.remove();
      peer.screenTile = null;
      if (room.focus === `s:${peer.user}`) room.focus = null;
    }
    if (peer.screenTile) {
      if (peer.screenTile.video.srcObject !== screen) peer.screenTile.video.srcObject = screen;
      peer.screenTile.node.classList.add("has-video");
      peer.screenTile.video.play?.().catch(() => {});
    }
  }
  for (const tile of tiles()) tile.node.classList.toggle("focused", room.focus === tile.key);
}
