// Windows (dialogs), confirm boxes and pop-up menus.

import { h } from "/js/dom.js";
import { icon } from "/js/icons.js";

export function openWindow({ title, body, className = "", onClose }) {
  const close = h("button", { class: "icon-btn", type: "button", "aria-label": "Close" }, icon("close"));
  const dialog = h("dialog", { class: `window ${className}`.trim() },
    h("header", { class: "window-title" }, h("h2", {}, title), close),
    h("div", { class: "window-body" }, body),
  );
  close.onclick = () => dialog.close();
  // A click on the dimmed area around the window closes it.
  dialog.addEventListener("pointerdown", (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export function confirmBox(text, { title = "Are you sure?", ok = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const yes = h("button", { class: `btn${danger ? " danger" : ""}`, type: "button" }, ok);
    const no = h("button", { class: "btn plain", type: "button" }, "Cancel");
    const dialog = openWindow({
      title,
      body: [h("p", {}, text), h("div", { class: "actions" }, no, yes)],
      onClose: () => resolve(answer),
    });
    yes.onclick = () => {
      answer = true;
      dialog.close();
    };
    no.onclick = () => dialog.close();
    yes.focus();
  });
}

// A small floating panel next to `anchor`. Closes on a click elsewhere,
// Escape, or scrolling.
let openPopover = null;

export function popover(anchor, content, { onClose } = {}) {
  closePopover();
  const node = h("div", { class: "popover", role: "menu" }, content);
  document.body.append(node);
  const a = anchor.getBoundingClientRect();
  const p = node.getBoundingClientRect();
  const gap = 8;
  let top = a.top - p.height - gap;
  if (top < gap) top = Math.min(a.bottom + gap, innerHeight - p.height - gap);
  const left = Math.min(Math.max(gap, a.left + a.width / 2 - p.width / 2), innerWidth - p.width - gap);
  node.style.top = `${Math.max(gap, top)}px`;
  node.style.left = `${left}px`;

  const away = (e) => {
    if (!node.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  const key = (e) => e.key === "Escape" && closePopover();
  setTimeout(() => {
    addEventListener("pointerdown", away, true);
    addEventListener("keydown", key);
    addEventListener("wheel", closePopover, { passive: true });
  });
  openPopover = () => {
    node.remove();
    removeEventListener("pointerdown", away, true);
    removeEventListener("keydown", key);
    removeEventListener("wheel", closePopover);
    onClose?.();
  };
  node.querySelector("button")?.focus({ preventScroll: true });
  return node;
}

export function closePopover() {
  const close = openPopover;
  openPopover = null;
  close?.();
}

export function menuItem(label, iconName, onClick, className = "") {
  return h("button", { class: `menu-item ${className}`.trim(), type: "button", role: "menuitem", onclick: () => {
    closePopover();
    onClick();
  } }, iconName ? icon(iconName) : null, label);
}
