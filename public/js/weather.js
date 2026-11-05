// Animated weather behind the chat: a few pixel particles per theme (snow,
// petals, leaves, rain, fireflies…). It runs at a low frame rate, pauses
// when the tab is hidden, and can be turned off in Settings. Nothing runs for
// people who've asked their device for reduced motion.

import { local } from "/js/dom.js";

const PX = 3;

// size is in pixels of the art; motion: fall, rise, drift, rain, flit or glow.
const WEATHER = {
  farmhouse: { count: 18, motion: "glow", colours: ["#ffe27a", "#fff3b0"], size: 1 },
  spring: { count: 22, motion: "fall", colours: ["#f6a9bf", "#fbd0dc", "#fffaf4"], size: 2 },
  summer: { count: 6, motion: "flit", colours: ["#fffaf0", "#ffd23f", "#9fd8f0"], size: 2 },
  autumn: { count: 18, motion: "fall", colours: ["#d0692c", "#e2a63b", "#a8402a"], size: 3 },
  winter: { count: 45, motion: "fall", colours: ["#eaf2ff", "#c9d6ee"], size: 1, slow: true },
  rainy: { count: 70, motion: "rain", colours: ["#8fa8c8", "#b8cbe2"], size: 1 },
  forest: { count: 14, motion: "fall", colours: ["#7fae4e", "#a8c86a", "#5d8a3a"], size: 3 },
  ocean: { count: 22, motion: "rise", colours: ["#bfe8f0", "#8fd0e0"], size: 2 },
  campfire: { count: 26, motion: "rise", colours: ["#ffb347", "#ff7a3a", "#ffe08a"], size: 1, fast: true },
};

let canvas = null;
let ctx = null;
let particles = [];
let setting = null;
let frame = 0;
let last = 0;

const enabled = () => local.get("weather") !== "off" && !matchMedia("(prefers-reduced-motion: reduce)").matches;

function particle(spec, anywhere) {
  const W = canvas.width / PX;
  const H = canvas.height / PX;
  return {
    x: Math.random() * W,
    y: anywhere ? Math.random() * H : spec.motion === "rise" ? H + 2 : -2,
    speed: (spec.slow ? 0.25 : spec.fast ? 1.2 : 0.5) * (0.6 + Math.random() * 0.8),
    sway: Math.random() * Math.PI * 2,
    colour: spec.colours[Math.floor(Math.random() * spec.colours.length)],
    life: Math.random() * 300,
  };
}

function resize() {
  canvas.width = Math.ceil(innerWidth / PX) * PX;
  canvas.height = Math.ceil(innerHeight / PX) * PX;
}

function step(time) {
  frame = requestAnimationFrame(step);
  // About 20 frames a second is plenty for pixels, and easy on batteries.
  if (time - last < 50) return;
  last = time;
  const spec = WEATHER[setting];
  const W = canvas.width / PX;
  const H = canvas.height / PX;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const p of particles) {
    p.life += 1;
    p.sway += 0.06;
    if (spec.motion === "fall") {
      p.y += p.speed;
      p.x += Math.sin(p.sway) * 0.4;
    } else if (spec.motion === "rise") {
      p.y -= p.speed;
      p.x += Math.sin(p.sway) * 0.3;
    } else if (spec.motion === "rain") {
      p.y += p.speed * 6;
      p.x -= p.speed * 1.5;
    } else if (spec.motion === "glow" || spec.motion === "flit") {
      p.x += Math.cos(p.sway * 0.7) * 0.3 + (spec.motion === "flit" ? 0.3 : 0);
      p.y += Math.sin(p.sway) * 0.3;
    }
    if (p.y > H + 4 || p.y < -6 || p.x < -6 || p.x > W + 6) {
      Object.assign(p, particle(spec, false));
      // Fireflies and butterflies reappear anywhere; rain starts off to the right as it slants left.
      if (spec.motion === "glow" || spec.motion === "flit") Object.assign(p, { x: Math.random() * W, y: Math.random() * H });
      if (spec.motion === "rain") p.x = Math.random() * (W + H / 3);
    }

    ctx.fillStyle = p.colour;
    const x = Math.round(p.x) * PX;
    const y = Math.round(p.y) * PX;
    if (spec.motion === "glow") {
      // Fireflies fade in and out.
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(p.life / 18));
      ctx.fillRect(x, y, PX, PX);
      ctx.globalAlpha = 0.25 * ctx.globalAlpha;
      ctx.fillRect(x - PX, y, PX * 3, PX);
      ctx.fillRect(x, y - PX, PX, PX * 3);
      ctx.globalAlpha = 1;
    } else if (spec.motion === "rain") {
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x, y, PX, PX * 3);
      ctx.globalAlpha = 1;
    } else if (spec.motion === "flit") {
      // Butterflies: two wings that flap.
      const open = Math.floor(p.life / 4) % 2 === 0;
      ctx.fillRect(x - (open ? PX * 2 : PX), y, open ? PX * 2 : PX, PX * 2);
      ctx.fillRect(x + PX, y, open ? PX * 2 : PX, PX * 2);
      ctx.fillStyle = "#3a2414";
      ctx.fillRect(x, y, PX, PX * 2);
    } else if (spec.size === 3) {
      // Leaves: a little diamond.
      ctx.fillRect(x + PX, y, PX, PX * 3);
      ctx.fillRect(x, y + PX, PX * 3, PX);
    } else {
      ctx.globalAlpha = spec.motion === "rise" && spec.fast ? 0.5 + 0.5 * Math.abs(Math.sin(p.life / 6)) : 0.85;
      ctx.fillRect(x, y, PX * spec.size, PX * spec.size);
      ctx.globalAlpha = 1;
    }
  }
}

function stop() {
  cancelAnimationFrame(frame);
  frame = 0;
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
}

// Called whenever the theme changes, and when the setting is switched.
export function setWeather(theme) {
  setting = theme;
  const spec = WEATHER[theme];
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "weather";
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    ctx = canvas.getContext("2d");
    addEventListener("resize", () => canvas && resize());
    document.addEventListener("visibilitychange", () => (document.hidden ? stop() : setWeather(setting)));
  }
  stop();
  if (!spec || !enabled()) {
    canvas.hidden = true;
    return;
  }
  canvas.hidden = false;
  resize();
  particles = Array.from({ length: spec.count }, () => particle(spec, true));
  frame = requestAnimationFrame(step);
}

export function setWeatherEnabled(on) {
  local.set("weather", on ? "on" : "off");
  setWeather(setting);
}

export const weatherEnabled = () => local.get("weather") !== "off";
