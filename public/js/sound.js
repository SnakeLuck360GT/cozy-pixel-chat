// Soft 8-bit blips made on the fly, so there are no sound files to load.

let ctx = null;
let enabled = true;
let ringTimer = null;

export const setSounds = (on) => (enabled = on);

// Browsers only allow sound after the first tap or key press.
for (const type of ["pointerdown", "keydown"]) {
  addEventListener(type, () => {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") ctx.resume();
  }, { once: false, passive: true });
}

function note(freq, at, length, volume = 0.05, type = "square") {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ctx.currentTime + at);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime + at);
  osc.stop(ctx.currentTime + at + length + 0.02);
}

const TUNES = {
  // Two rising notes, like picking something up.
  message: [[988, 0, 0.09], [1319, 0.08, 0.14]],
  sent: [[784, 0, 0.06, 0.025]],
  hangup: [[659, 0, 0.12], [523, 0.12, 0.12], [392, 0.24, 0.22]],
  ring: [[523, 0, 0.14], [659, 0.15, 0.14], [784, 0.3, 0.14], [1047, 0.45, 0.3]],
};

export function play(name, force = false) {
  if ((!enabled && !force) || !ctx || ctx.state !== "running") return;
  for (const [freq, at, length, volume] of TUNES[name]) note(freq, at, length, volume);
}

// Calls ring even with message sounds turned off.
export function startRinging() {
  stopRinging();
  play("ring", true);
  ringTimer = setInterval(() => play("ring", true), 1800);
}

export function stopRinging() {
  clearInterval(ringTimer);
  ringTimer = null;
}
