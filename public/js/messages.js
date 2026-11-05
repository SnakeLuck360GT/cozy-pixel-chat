// Draws a chat's messages: runs of bubbles from the same person, day and
// time stamps, replies, reactions, attachments, and the actions on each.
// Rows are cached by what they show, so redrawing after a new message
// keeps everything else (playing videos, loaded images) in place.

import { api } from "/js/api.js";
import { avatar, chatAvatar } from "/js/avatar.js";
import { clock, dayLabel, formatBytes, h, sameDay, toast, touch } from "/js/dom.js";
import { icon } from "/js/icons.js";
import { attachmentWord, callText, isMe, nameOf, partnerOf, state, systemText, thread, userOf } from "/js/store.js";
import { closePopover, confirmBox, menuItem, openWindow, popover } from "/js/ui.js";
import { sticker } from "/js/stickers.js";
import { voicePlayer } from "/js/voice.js";
import { youTubeId } from "/js/watch.js";

const RUN_GAP_MS = 5 * 60 * 1000;
const STAMP_GAP_MS = 60 * 60 * 1000;
export const QUICK = ["❤️", "😂", "😮", "😢", "😡", "👍"];
const MORE = [
  "🥰", "😍", "😘", "🥺", "😭", "😊", "😆", "🤣", "😅", "🙃", "😉", "😌", "😴", "🤔", "🤗", "😳",
  "😎", "🤩", "🥲", "😤", "🙄", "😬", "🤭", "🫶", "👏", "🙌", "🙏", "💪", "👀", "✨", "🔥", "💯",
  "🎉", "🌸", "🌻", "🍂", "❄️", "☕", "🍰", "🍓", "🐱", "🐶", "🐸", "🌙", "⭐", "🌈", "💤", "💌",
];

// Set by chat.js: what reply, edit, call back and image clicks do.
export const hooks = { reply() {}, edit() {}, call() {}, openImage() {}, retry() {}, watch() {}, jump() {}, profile() {} };

const cache = new Map();
export const clearCache = () => cache.clear();

// Rows for a list of messages: stamps, the unread line, notes and bubbles,
// with each bubble marked as the first and/or last of its run.
function buildRows(messages, unreadFrom) {
  const rows = [];
  let prev = null;
  for (const m of messages) {
    let breaks = false;
    if (!prev || !sameDay(prev.created, m.created)) {
      rows.push({ type: "stamp", key: `day-${m.id}`, text: `${dayLabel(m.created)} ${clock(m.created)}` });
      breaks = true;
    } else if (m.created - prev.created > STAMP_GAP_MS) {
      rows.push({ type: "stamp", key: `time-${m.id}`, text: clock(m.created) });
      breaks = true;
    }
    if (m.id === unreadFrom) {
      rows.push({ type: "unread", key: "unread" });
      breaks = true;
    }
    if (m.kind === "system") {
      rows.push({ type: "note", key: `m-${m.id}`, m });
    } else {
      const first = breaks || !prev || prev.kind === "system" || prev.user !== m.user || m.created - prev.created > RUN_GAP_MS;
      rows.push({ type: "msg", key: `m-${m.id}`, m, first });
    }
    prev = m;
  }
  rows.forEach((row, i) => {
    if (row.type !== "msg") return;
    const next = rows[i + 1];
    row.last = !next || next.type !== "msg" || next.first;
  });
  return rows;
}

// "Seen" goes under your newest message once the others have read it.
function seenLine(conv, messages) {
  const mine = messages.findLast((m) => !m.pending && m.kind !== "system");
  if (!mine || !isMe(mine.user)) return { id: null, text: "" };
  const readers = conv.members.filter((m) => !isMe(m.id) && m.lastRead >= mine.id).map((m) => m.id);
  if (conv.kind === "dm") return { id: mine.id, text: readers.length ? "Seen" : "Sent" };
  if (!readers.length) return { id: mine.id, text: "Sent" };
  const everyone = readers.length === conv.members.length - 1;
  return { id: mine.id, text: everyone ? "Seen by everyone" : `Seen by ${readers.map(nameOf).join(", ")}` };
}

export function renderMessages(list, conv, { unreadFrom } = {}) {
  const t = thread(conv.id);
  const seen = seenLine(conv, t.messages);
  const nodes = [];
  if (!t.hasMore) nodes.push(cached(`start-${conv.id}`, conv.kind + conv.name, () => historyStart(conv)));
  for (const row of buildRows(t.messages, unreadFrom)) {
    if (row.type === "stamp") nodes.push(cached(row.key, row.text, () => h("li", { class: "stamp" }, h("span", {}, row.text))));
    else if (row.type === "unread") nodes.push(cached("unread", "", () => h("li", { class: "unread-line" }, h("span", {}, "New"))));
    else if (row.type === "note") nodes.push(cached(row.key, systemText(row.m), () => h("li", { class: "note" }, h("span", {}, systemText(row.m)))));
    else {
      const m = row.m;
      const seenText = m.id === seen.id ? seen.text : "";
      const signature = JSON.stringify([m.body, m.meta, m.edited, m.deleted, m.pinned, m.reactions, m.pending, m.failed, row.first, row.last, seenText, conv.kind, m.kind === "call" && state.calls.has(conv.id)]);
      nodes.push(cached(row.key, signature, () => messageRow(row, conv, seenText)));
    }
  }
  nodes.push(...typingRows(conv));
  list.replaceChildren(...nodes);
}

function cached(key, signature, make) {
  const hit = cache.get(key);
  if (hit && hit.signature === signature) return hit.node;
  const node = make();
  cache.set(key, { signature, node });
  return node;
}

function historyStart(conv) {
  const partner = partnerOf(conv);
  return h("li", { class: "history-start" },
    chatAvatar(conv, partner, 56),
    h("strong", {}, partner ? partner.displayName : conv.name || "Your group"),
    h("span", {}, partner ? `This is the start of your chat with @${partner.name}` : `This is the start of ${conv.kind === "server" ? "the server" : "the group"}`),
  );
}

function typingRows(conv) {
  const typing = [...(state.typing.get(conv.id)?.keys() ?? [])];
  return typing.map((userId) => h("li", { class: "typing-row", "aria-label": `${nameOf(userId)} is typing` },
    h("span", { class: "msg-avatar" }, avatar(userOf(userId), 28)),
    h("span", { class: "typing-dots" }, h("i"), h("i"), h("i")),
  ));
}

// One message

function messageRow(row, conv, seenText) {
  const m = row.m;
  const mine = isMe(m.user);
  const classes = ["msg", mine ? "mine" : "theirs", row.first && "first", row.last && "last", m.pending && "pending", m.failed && "failed"];
  const li = h("li", { class: classes.filter(Boolean).join(" "), dataset: { id: m.id } });

  const stack = h("div", { class: "msg-stack" });
  if (conv.kind !== "dm" && !mine && row.first && m.kind !== "call") {
    stack.append(h("button", { class: "msg-sender", type: "button", onclick: () => hooks.profile(m.user) }, nameOf(m.user)));
  }
  if (m.replyTo && !m.deleted) stack.append(replyQuote(m));

  if (m.kind === "call") stack.append(callCard(m, conv));
  else if (m.kind === "sticker" && !m.deleted) stack.append(h("div", { class: "sticker" }, sticker(m.meta?.sticker ?? "", m.meta?.url)));
  else if (m.deleted) stack.append(h("div", { class: "bubble unsent" }, mine ? "You unsent a message" : `${nameOf(m.user)} unsent a message`));
  else {
    if (m.attachments?.length) stack.append(attachmentsNode(m));
    if (m.body) stack.append(textBubble(m.body));
    const videoId = youTubeId(m.body);
    if (videoId) {
      stack.append(h("button", { class: "watch-link", type: "button", onclick: () => hooks.watch(m.c, videoId) }, icon("tv", "mid"), "Watch together"));
    }
  }
  if (m.reactions?.length) stack.append(reactionsNode(m));

  const meta = [];
  if (m.pinned && !m.deleted) meta.push("Pinned");
  if (m.edited && !m.deleted) meta.push("Edited");
  if (seenText) meta.push(seenText);
  if (m.pending && !m.failed) meta.push("Sending");
  if (meta.length || m.failed) {
    const line = h("div", { class: "msg-meta" }, meta.join(" · "));
    if (m.failed) line.append(h("span", {}, "Not sent"), " ", h("button", { class: "link-btn", type: "button", onclick: () => hooks.retry(m) }, "Retry"));
    stack.append(line);
  }

  const avatarSlot = h("span", { class: "msg-avatar" }, !mine && row.last
    ? h("button", { class: "avatar-btn", type: "button", "aria-label": `${nameOf(m.user)}'s profile`, onclick: () => hooks.profile(m.user) }, avatar(userOf(m.user) ?? { name: "?" }, 28))
    : null);
  li.append(avatarSlot, stack);

  const actionable = !m.pending && !m.deleted && m.kind !== "call";
  if (actionable) {
    li.append(tools(m));
    gestures(stack, m);
  }
  li.title = new Date(m.created).toLocaleString();
  return li;
}

function replyQuote(m) {
  const r = m.replyTo;
  const who = isMe(m.user)
    ? `You replied to ${r.user && isMe(r.user) ? "yourself" : nameOf(r.user)}`
    : `${nameOf(m.user)} replied to ${r.user && isMe(r.user) ? "you" : r.user === m.user ? "themselves" : nameOf(r.user)}`;
  const text = r.deleted ? "Unsent message" : r.kind === "sticker" ? "Sticker" : r.body || attachmentWord(r.attachment);
  return h("button", { class: "reply-quote", type: "button", onclick: () => jumpTo(r.id) },
    h("small", {}, who), h("span", {}, text));
}

const jumpTo = (id) => hooks.jump(id);

// Links and @mentions are made from text nodes, never HTML.
const LINK = /(https?:\/\/[^\s<>"]+[^\s<>".,:;!?'")\]])|(@[a-z0-9_-]{2,32})/gi;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;

function textBubble(text) {
  if (EMOJI_ONLY.test(text)) return h("div", { class: "bubble jumbo" }, text);
  const bubble = h("div", { class: "bubble" });
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    bubble.append(text.slice(last, match.index));
    if (match[1]) {
      bubble.append(h("a", { href: match[1], target: "_blank", rel: "noopener noreferrer" }, match[1]));
    } else {
      const name = match[2].slice(1).toLowerCase();
      const user = [...state.users.values()].find((u) => u.name === name) ?? (state.me.name === name ? state.me : null);
      bubble.append(user ? h("span", { class: `mention${isMe(user.id) ? " me" : ""}` }, match[2]) : match[2]);
    }
    last = match.index + match[0].length;
  }
  bubble.append(text.slice(last));
  return bubble;
}

function attachmentsNode(m) {
  const node = h("div", { class: "attachments" });
  const images = m.attachments.filter((a) => a.kind === "image");
  if (images.length === 1) node.append(imageButton(images[0]));
  else if (images.length > 1) node.append(h("div", { class: "media-grid" }, images.map(imageButton)));
  for (const a of m.attachments) {
    if (a.kind === "video") {
      const video = h("video", { class: "media", src: a.url, controls: true, preload: "metadata", playsinline: true });
      if (a.meta?.w) video.style.aspectRatio = `${a.meta.w} / ${a.meta.h}`;
      node.append(video);
    } else if (a.kind === "voice") node.append(voicePlayer(a));
    else if (a.kind === "audio") node.append(h("audio", { class: "audio-file", src: a.url, controls: true, preload: "metadata" }));
    else if (a.kind === "file") {
      node.append(h("a", { class: "file-card", href: a.url, target: "_blank", rel: "noopener noreferrer" },
        icon("file"), h("span", {}, h("strong", {}, a.name), h("small", {}, `${formatBytes(a.size)} · Download`))));
    }
  }
  return node;
}

function imageButton(a) {
  const img = h("img", { src: a.url, alt: a.name, loading: "lazy", decoding: "async" });
  // Sized up front from the dimensions sent with the upload, so the list
  // doesn't jump as photos load.
  if (a.meta?.w) {
    const scale = Math.min(1, 320 / a.meta.w, 340 / a.meta.h);
    img.style.width = `${Math.round(a.meta.w * scale)}px`;
    img.style.aspectRatio = `${a.meta.w} / ${a.meta.h}`;
  }
  return h("button", { class: "media", type: "button", "aria-label": `Open ${a.name}`, onclick: () => hooks.openImage(a) }, img);
}

function callCard(m, conv) {
  const { title, detail, missed } = callText(m);
  const video = Boolean(m.meta?.video);
  const card = h("div", { class: `call-card${missed ? " missed" : ""}` },
    h("span", { class: "glyph" }, icon(video ? "video" : "phone", "mid")),
    h("span", {}, h("strong", {}, title), h("small", {}, detail)),
  );
  card.append(h("button", { class: "link-btn", type: "button", onclick: () => hooks.call(conv, video) }, state.calls.has(conv.id) ? "Join" : "Call back"));
  return card;
}

function reactionsNode(m) {
  const groups = new Map();
  for (const r of m.reactions) {
    if (!groups.has(r.emoji)) groups.set(r.emoji, []);
    groups.get(r.emoji).push(r.user);
  }
  return h("div", { class: "reactions" }, [...groups].map(([emoji, users]) =>
    h("button", {
      class: `reaction${users.some(isMe) ? " mine" : ""}`,
      type: "button",
      title: users.map((u) => (isMe(u) ? "You" : nameOf(u))).join(", "),
      onclick: () => react(m, emoji),
    }, emoji, users.length > 1 ? h("small", {}, String(users.length)) : null),
  ));
}

// Actions

async function react(m, emoji) {
  closePopover();
  try {
    await api(`/api/messages/${m.id}/reaction`, { method: "PUT", body: { emoji } });
  } catch (err) {
    toast(err.message, true);
  }
}

const myReaction = (m) => m.reactions.find((r) => isMe(r.user))?.emoji;

function emojiPicker(m) {
  const mine = myReaction(m);
  const pick = (emoji) => h("button", { class: `emoji-btn${emoji === mine ? " chosen" : ""}`, type: "button", onclick: () => react(m, emoji) }, emoji);
  const more = h("button", { class: "emoji-btn", type: "button", "aria-label": "More reactions" }, icon("plus", "mid"));
  const grid = h("div", { class: "emoji-grid", hidden: true }, MORE.map(pick));
  more.onclick = () => {
    grid.hidden = !grid.hidden;
    more.setAttribute("aria-expanded", String(!grid.hidden));
  };
  return [h("div", { class: "emoji-row" }, QUICK.map(pick), more), grid];
}

async function unsend(m) {
  const ok = await confirmBox("It'll be removed for everyone in the chat.", { title: "Unsend message?", ok: "Unsend", danger: true });
  if (!ok) return;
  try {
    await api(`/api/messages/${m.id}`, { method: "DELETE" });
  } catch (err) {
    toast(err.message, true);
  }
}

function actionItems(m) {
  const items = [menuItem("Reply", "reply", () => hooks.reply(m))];
  if (m.body) items.push(menuItem("Copy text", "copy", () => navigator.clipboard.writeText(m.body).then(() => toast("Copied"))));
  items.push(menuItem(m.pinned ? "Unpin" : "Pin", "pin", () => api(`/api/messages/${m.id}/pin`, { method: "PUT", body: { pinned: !m.pinned } }).catch((err) => toast(err.message, true))));
  if (isMe(m.user) && m.kind === "text") items.push(menuItem("Edit", "pencil", () => hooks.edit(m)));
  if (isMe(m.user)) items.push(menuItem("Unsend", "trash", () => unsend(m), "danger"));
  return items;
}

function tools(m) {
  const bar = h("div", { class: "msg-tools" });
  const reactBtn = h("button", { class: "icon-btn", type: "button", "aria-label": "React" }, icon("smile"));
  const replyBtn = h("button", { class: "icon-btn", type: "button", "aria-label": "Reply", onclick: () => hooks.reply(m) }, icon("reply"));
  const moreBtn = h("button", { class: "icon-btn", type: "button", "aria-label": "More" }, icon("dots"));
  const open = (button, content) => {
    bar.classList.add("open");
    button.setAttribute("aria-expanded", "true");
    popover(button, content, { onClose: () => {
      bar.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    } });
  };
  reactBtn.onclick = () => open(reactBtn, emojiPicker(m));
  moreBtn.onclick = () => open(moreBtn, actionItems(m));
  bar.append(reactBtn, replyBtn, moreBtn);
  return bar;
}

// Phones: hold a message for its actions, double-tap to heart it.
// Computers: double-click to heart.
function gestures(target, m) {
  let timer = null;
  let start = null;
  let lastTap = 0;
  target.addEventListener("dblclick", (e) => {
    if (touch || e.target.closest("a, button, video, audio, canvas")) return;
    react(m, "❤️");
  });
  if (!touch) return;
  target.addEventListener("contextmenu", (e) => e.preventDefault());
  target.addEventListener("pointerdown", (e) => {
    if (e.target.closest("a, button, video, audio, canvas")) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      navigator.vibrate?.(10);
      sheet(m);
    }, 450);
  });
  target.addEventListener("pointermove", (e) => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) {
      clearTimeout(timer);
      timer = null;
    }
  });
  const up = (e) => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    if (e.type !== "pointerup" || e.target.closest("a, button, video, audio, canvas")) return;
    const now = Date.now();
    if (now - lastTap < 320) {
      lastTap = 0;
      react(m, "❤️");
    } else lastTap = now;
  };
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}

function sheet(m) {
  const dialog = openWindow({ title: "Message", className: "sheet", body: [emojiPicker(m), actionItems(m)] });
  dialog.addEventListener("click", (e) => {
    if (e.target.closest(".emoji-btn:not([aria-label]), .menu-item")) dialog.close();
  });
}
