// Small helpers shared by every page. User content only ever goes in as
// text (textContent or text nodes), never as HTML.

export const $ = (id) => document.getElementById(id);

// h("button", { class: "btn", onclick }, "Label", child, ...)
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  node.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return node;
}

// Phones and tablets: tap wording, no hover toolbars, Enter adds a new line.
export const touch = matchMedia("(hover: none)").matches;

export function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export const clock = (time) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const startOfDay = (time) => new Date(time).setHours(0, 0, 0, 0);
export const sameDay = (a, b) => startOfDay(a) === startOfDay(b);

// "Today", "Yesterday", "Monday", "3 Nov", "3 Nov 2025"
export function dayLabel(time) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(time)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(time).toLocaleDateString([], { weekday: "long" });
  const sameYear = new Date(time).getFullYear() === new Date().getFullYear();
  return new Date(time).toLocaleDateString([], { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" });
}

// For the chat list: "now", "5m", "3h", "Mon", "3 Nov"
export function shortTime(time) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (sameDay(time, Date.now())) return `${Math.floor(minutes / 60)}h`;
  const days = Math.round((startOfDay(Date.now()) - startOfDay(time)) / 86_400_000);
  if (days < 7) return new Date(time).toLocaleDateString([], { weekday: "short" });
  return new Date(time).toLocaleDateString([], { day: "numeric", month: "short" });
}

export function agoText(time) {
  if (!time) return "Offline";
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "Active just now";
  if (minutes < 60) return `Active ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Active ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `Active ${days}d ago` : "Offline";
}

export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// localStorage can be missing or full (private windows); it only ever holds
// conveniences, so failures are ignored.
export const local = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

export function toast(text, isError = false) {
  document.querySelector(".toast")?.remove();
  const node = h("div", { class: `toast${isError ? " error" : ""}`, role: "status" }, text);
  document.body.append(node);
  // Longer messages stay up long enough to read.
  setTimeout(() => node.remove(), Math.max(3200, text.length * 70));
}
