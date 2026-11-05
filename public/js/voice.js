// Voice notes: recording with a live level meter, and a player with a
// pixel waveform you can tap to seek.

import { duration, h } from "/js/dom.js";
import { icon } from "/js/icons.js";

const MAX_MS = 5 * 60 * 1000;
const BARS = 28;
// AAC in MP4 plays everywhere, so it's preferred; Firefox only records WebM or Ogg.
const TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];

export const canRecord = () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

function resample(values, count) {
  if (!values.length) return Array(count).fill(0.1);
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * values.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / count));
    return Math.max(...values.slice(from, to));
  });
}

// Square bars on a pixel grid. `progress` (0..1) colours the played part.
function drawBars(canvas, peaks, progress, colour) {
  const scale = Math.max(1, Math.round(devicePixelRatio || 1));
  const width = canvas.clientWidth || 168;
  const height = canvas.clientHeight || 30;
  if (canvas.width !== width * scale) {
    canvas.width = width * scale;
    canvas.height = height * scale;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const bars = resample(peaks, Math.floor(width / 6));
  const unit = 2 * scale;
  bars.forEach((peak, i) => {
    const rows = Math.max(1, Math.round((peak * height) / 2));
    const barHeight = rows * unit;
    ctx.fillStyle = colour;
    ctx.globalAlpha = (i + 0.5) / bars.length <= progress ? 1 : 0.35;
    ctx.fillRect(i * 6 * scale, Math.round((canvas.height - barHeight) / 2 / unit) * unit, 4 * scale, barHeight);
  });
  ctx.globalAlpha = 1;
}

// Replaces `row` with a recorder while recording. Resolves with the
// recording, or null if cancelled.
export async function record(row) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64_000 } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 1024;
  audio.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const levels = [];

  const time = h("time", {}, "0:00");
  const canvas = h("canvas");
  const cancel = h("button", { class: "icon-btn", type: "button", "aria-label": "Delete recording" }, icon("trash"));
  const send = h("button", { class: "icon-btn accent", type: "button", "aria-label": "Send voice message" }, icon("send"));
  const bar = h("div", { class: "recorder" }, cancel, h("span", { class: "rec-dot" }), time, canvas, send);
  row.hidden = true;
  row.after(bar);

  const started = performance.now();
  recorder.start(250);
  const meter = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    levels.push(Math.sqrt(sum / samples.length));
    const elapsed = performance.now() - started;
    time.textContent = duration(elapsed);
    const recent = levels.slice(-Math.floor((canvas.clientWidth || 200) / 6));
    drawBars(canvas, recent.map((l) => Math.min(1, l * 6)), 1, getComputedStyle(bar).color);
    if (elapsed >= MAX_MS) send.click();
  }, 80);

  return new Promise((resolve) => {
    const finish = (keep) => {
      clearInterval(meter);
      const elapsed = performance.now() - started;
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        audio.close();
        bar.remove();
        row.hidden = false;
        if (!keep || elapsed < 600) return resolve(null);
        const type = recorder.mimeType || mimeType || "audio/webm";
        const loudest = Math.max(0.02, ...levels);
        resolve({
          blob: new Blob(chunks, { type }),
          name: `voice.${type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"}`,
          duration: elapsed / 1000,
          peaks: resample(levels, 48).map((l) => Math.round(Math.sqrt(l / loudest) * 100) / 100),
        });
      };
      recorder.stop();
    };
    cancel.onclick = () => finish(false);
    send.onclick = () => finish(true);
  });
}

// Only one voice note plays at a time.
let current = null;

export function voicePlayer(attachment) {
  const total = (attachment.meta?.duration ?? 0) * 1000;
  const peaks = attachment.meta?.peaks?.length ? attachment.meta.peaks : Array(24).fill(0.4);
  const audio = new Audio();
  audio.preload = "none";
  audio.src = attachment.url;

  const button = h("button", { class: "icon-btn", type: "button", "aria-label": "Play voice message" }, icon("play"));
  const canvas = h("canvas", { role: "slider", "aria-label": "Position", tabindex: "-1" });
  const time = h("time", {}, duration(total));
  const node = h("div", { class: "voice" }, button, canvas, time);

  let frame = 0;
  const length = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total / 1000);
  const draw = () => drawBars(canvas, peaks, length() ? audio.currentTime / length() : 0, getComputedStyle(node).color);
  const tick = () => {
    draw();
    time.textContent = duration(audio.currentTime * 1000);
    if (!audio.paused) frame = requestAnimationFrame(tick);
  };

  audio.onplay = () => {
    button.replaceChildren(icon("pause"));
    button.setAttribute("aria-label", "Pause");
    frame = requestAnimationFrame(tick);
  };
  audio.onpause = () => {
    button.replaceChildren(icon("play"));
    button.setAttribute("aria-label", "Play voice message");
    cancelAnimationFrame(frame);
    draw();
  };
  audio.onended = () => {
    audio.currentTime = 0;
    time.textContent = duration(total);
    draw();
  };

  button.onclick = () => {
    if (audio.paused) {
      if (current && current !== audio) current.pause();
      current = audio;
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  };
  canvas.onclick = (e) => {
    const fraction = Math.min(1, Math.max(0, e.offsetX / canvas.clientWidth));
    const seek = () => {
      audio.currentTime = fraction * length();
      draw();
    };
    if (audio.readyState >= 1) seek();
    else {
      audio.preload = "metadata";
      audio.addEventListener("loadedmetadata", seek, { once: true });
      audio.load();
    }
  };

  // Drawn once it's on the page and has a size.
  requestAnimationFrame(draw);
  new ResizeObserver(draw).observe(canvas);
  return node;
}
