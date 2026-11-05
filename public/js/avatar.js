// Square avatars. People without a picture get a little pixel pattern made
// from their username, mirrored like a space invader, so it's always theirs.

import { h } from "/js/dom.js";

// Foreground and background pairs that sit well on every theme.
const PAIRS = [
  ["#d0692c", "#fbe3c8"], ["#5d9e34", "#e4f2cf"], ["#df6489", "#fde2ea"], ["#3fa7aa", "#d6f1ef"],
  ["#7a5bb5", "#e9e1f7"], ["#c9a227", "#f8efc9"], ["#3a63a6", "#dde6f5"], ["#b8461f", "#f6dccf"],
];

function hash(text) {
  let n = 2166136261;
  for (const c of text) n = Math.imul(n ^ c.codePointAt(0), 16777619);
  return n >>> 0;
}

const NS = "http://www.w3.org/2000/svg";

export function pattern(seed) {
  const n = hash(seed);
  const [fg, bg] = PAIRS[n % PAIRS.length];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 7 7");
  svg.setAttribute("aria-hidden", "true");
  const back = document.createElementNS(NS, "rect");
  back.setAttribute("width", "7");
  back.setAttribute("height", "7");
  back.setAttribute("fill", bg);
  svg.append(back);
  let d = "";
  // 5×5, with the left three columns mirrored to the right.
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (!((n >>> (3 + y * 3 + x)) & 1)) continue;
      d += `M${1 + x} ${1 + y}h1v1h-1z`;
      if (x < 2) d += `M${5 - x} ${1 + y}h1v1h-1z`;
    }
  }
  const cells = document.createElementNS(NS, "path");
  cells.setAttribute("d", d || "M3 3h1v1h-1z");
  cells.setAttribute("fill", fg);
  svg.append(cells);
  return svg;
}

// A chat's picture: the other person's, the group or server's own, or a pattern.
export function chatAvatar(conv, partner, size = 40, options = {}) {
  if (partner) return avatar(partner, size, options);
  return avatar({ name: `group-${conv.id}`, avatar: conv.icon }, size, options);
}

export function avatar(user, size = 40, { online = false, seed } = {}) {
  const box = h("span", { class: `avatar s${size}${online ? " online" : ""}` });
  if (user?.avatar) {
    const img = h("img", { src: user.avatar, alt: "", loading: "lazy", decoding: "async" });
    img.onerror = () => img.replaceWith(pattern(user.name));
    box.append(img);
  } else {
    box.append(pattern(seed ?? user?.name ?? "?"));
  }
  return box;
}
