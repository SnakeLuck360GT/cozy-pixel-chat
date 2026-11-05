// The open chat: its header, the scrolling message list, and the composer
// (text, replies, edits, attachments and voice notes).

import { api, upload } from "/js/api.js";
import { chatAvatar } from "/js/avatar.js";
import { $, agoText, h, local, toast, touch } from "/js/dom.js";
import { icon } from "/js/icons.js";
import { clearCache, hooks, renderMessages } from "/js/messages.js";
import { details, lightbox, settings, themePicker } from "/js/panels.js";
import { actionButton, openProfile } from "/js/profile.js";
import { currentCall, joinCall } from "/js/calls.js";
import { openPins, openSearch } from "/js/search.js";
import { renderStage } from "/js/stage.js";
import { stickerPicker } from "/js/stickers.js";
import { startWatch, stopWatch, youTubeId } from "/js/watch.js";
import * as socket from "/js/socket.js";
import { play } from "/js/sound.js";
import {
  attachmentWord, emit, isMe, nameOf, partnerOf, previewText, removeMessage, state, thread, titleOf, upsertMessages,
} from "/js/store.js";
import { applyTheme } from "/js/themes.js";
import { canRecord, record } from "/js/voice.js";

const MAX_IMAGE_SIDE = 2560;
const MAX_FILES = 10;
const els = {};
const composer = { mode: null, uploads: [] };
let unreadFrom = null;
let stick = true;
let loadingOlder = false;
let lastTypingSent = 0;

export function initChat() {
  for (const id of ["empty-pane", "convo", "convo-head", "messages", "message-list", "composer", "composer-bar", "tray", "composer-row", "composer-input", "attach", "file-input", "sticker-btn", "mic", "send", "jump", "drop-hint"]) {
    els[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = $(id);
  }

  hooks.reply = (m) => setMode({ type: "reply", m });
  hooks.edit = (m) => setMode({ type: "edit", m });
  hooks.call = (conv, video) => joinCall(conv.id, video);
  hooks.watch = (c, videoId) => startWatch(c, videoId);
  hooks.jump = (id) => jumpToMessage(state.current, id);
  hooks.profile = showProfile;
  els.stickerBtn.append(icon("sticker"));
  els.stickerBtn.onclick = () => stickerPicker(els.stickerBtn, sendSticker);
  hooks.openImage = lightbox;
  hooks.retry = retry;

  els.messages.addEventListener("scroll", () => {
    stick = nearBottom();
    if (stick) els.jump.hidden = true;
    if (els.messages.scrollTop < 400) loadOlder();
  }, { passive: true });
  // Images and voice notes change height as they load; stay at the bottom if we were.
  new ResizeObserver(() => stick && toBottom()).observe(els.messageList);
  els.jump.onclick = () => {
    stick = true;
    toBottom(true);
  };

  els.composerInput.addEventListener("input", () => {
    autosize();
    updateButtons();
    const c = state.current;
    if (c && els.composerInput.value.trim() && composer.mode?.type !== "edit" && Date.now() - lastTypingSent > 3000) {
      lastTypingSent = Date.now();
      socket.send({ t: "typing", c });
    }
  });
  els.composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !touch && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape" && composer.mode) {
      setMode(null);
    } else if (e.key === "ArrowUp" && !els.composerInput.value) {
      // Up arrow in an empty box edits your last message, like most chat apps.
      const last = thread(state.current).messages.findLast((m) => isMe(m.user) && m.kind === "text" && !m.deleted && !m.pending);
      if (last) {
        e.preventDefault();
        setMode({ type: "edit", m: last });
      }
    }
  });
  els.composerInput.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  els.attach.onclick = () => els.fileInput.click();
  els.fileInput.onchange = () => {
    addFiles([...els.fileInput.files]);
    els.fileInput.value = "";
  };
  els.mic.hidden = !canRecord();
  els.mic.onclick = recordVoice;

  // Drag files anywhere onto the open chat.
  let depth = 0;
  const pane = els.convo;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  pane.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    els.dropHint.hidden = false;
  });
  pane.addEventListener("dragleave", () => {
    if (--depth <= 0) {
      depth = 0;
      els.dropHint.hidden = true;
    }
  });
  pane.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
  pane.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    els.dropHint.hidden = true;
    addFiles([...e.dataTransfer.files]);
  });

  document.addEventListener("visibilitychange", markRead);
  addEventListener("focus", markRead);
  updateButtons();
}

const nearBottom = () => els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 120;

function toBottom(smooth = false) {
  els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: smooth ? "smooth" : "instant" });
}

const currentConv = () => state.conversations.get(state.current);

// Opening and closing

export async function openConversation(c) {
  const conv = state.conversations.get(c);
  if (!conv) return;
  if (state.current !== c) {
    resetComposer();
    unreadFrom = null;
  }
  state.current = c;
  applyTheme(conv.theme);
  els.emptyPane.hidden = true;
  els.convo.hidden = false;
  renderHeader();
  renderStage();

  const myLastRead = conv.members.find((m) => isMe(m.id))?.lastRead ?? 0;
  const t = thread(c);
  if (!t.loaded) {
    els.messageList.replaceChildren();
    try {
      const { messages, hasMore } = await api(`/api/conversations/${c}/messages`);
      upsertMessages(c, messages);
      t.hasMore = hasMore;
      t.loaded = true;
    } catch (err) {
      return toast(err.message, true);
    }
    if (state.current !== c) return;
  }
  unreadFrom = conv.unread ? (t.messages.find((m) => m.id > myLastRead && !isMe(m.user) && !m.pending && m.kind !== "system")?.id ?? null) : null;
  renderList();
  const divider = els.messageList.querySelector(".unread-line");
  if (divider && divider.offsetTop > els.messages.clientHeight) {
    stick = false;
    els.messages.scrollTop = divider.offsetTop - 80;
  } else {
    stick = true;
    toBottom();
  }
  markRead();
  if (!touch) els.composerInput.focus();
}

export function closeConversation() {
  state.current = null;
  resetComposer();
  els.convo.hidden = true;
  els.emptyPane.hidden = false;
  applyTheme(state.me.prefs.theme);
  renderStage();
}

export function renderList() {
  const conv = currentConv();
  if (!conv) return;
  const wasAtBottom = stick;
  renderMessages(els.messageList, conv, { unreadFrom });
  if (wasAtBottom) toBottom();
}

export function renderHeader() {
  const conv = currentConv();
  if (!conv) return;
  const partner = partnerOf(conv);
  const online = partner && state.online.has(partner.id);
  const typing = [...(state.typing.get(conv.id)?.keys() ?? [])];
  let status;
  if (typing.length) status = conv.kind === "dm" ? "typing…" : `${typing.map(nameOf).join(", ")} typing…`;
  else if (partner) status = [online ? "Online" : agoText(partner.lastSeen), partner.status].filter(Boolean).join(" · ");
  else status = `${conv.members.length} people`;

  const button = (name, label, onclick) => h("button", { class: "icon-btn", type: "button", "aria-label": label, title: label, onclick }, icon(name));
  // Calls: start one, or join the one already going. Once you're in, the
  // buttons are in the call area instead.
  const inThisCall = currentCall()?.c === conv.id;
  const callGoing = state.calls.has(conv.id);
  let callButtons = [];
  if (callGoing && !inThisCall) {
    callButtons = [h("button", { class: "btn join-call", type: "button", onclick: () => joinCall(conv.id, false) }, icon("phone", "mid"), "Join call")];
  } else if (!inThisCall) {
    callButtons = [button("phone", "Voice call", () => joinCall(conv.id, false)), button("video", "Video call", () => joinCall(conv.id, true))];
  }
  els.convoHead.replaceChildren(
    h("a", { class: "icon-btn back-btn", href: "#/", "aria-label": "Back to chats" }, icon("back")),
    h("button", { class: "convo-who", type: "button", onclick: () => (partner ? showProfile(partner.id) : details(conv, { onCall: (cv, video) => joinCall(cv.id, video) })) },
      chatAvatar(conv, partner, 40, { online }),
      h("span", {},
        h("span", { class: "convo-name" }, titleOf(conv)),
        h("span", { class: `convo-status${typing.length || online ? " live" : ""}` }, status),
      ),
    ),
    ...callButtons,
    button("search", "Search this chat", () => openSearch({ c: conv.id, onJump: jumpToMessage })),
    button("pin", "Pinned messages", () => openPins(conv, { onJump: jumpToMessage })),
    button("palette", "Chat theme", () => themePicker(conv)),
  );
}

async function loadOlder() {
  const c = state.current;
  const t = c && thread(c);
  if (!t || loadingOlder || !t.hasMore || !t.loaded) return;
  const first = t.messages.find((m) => !m.pending);
  if (!first) return;
  loadingOlder = true;
  try {
    const { messages, hasMore } = await api(`/api/conversations/${c}/messages?before=${first.id}`);
    upsertMessages(c, messages);
    t.hasMore = hasMore;
    if (state.current === c) {
      // Keep the same messages in view while older ones appear above.
      const fromBottom = els.messages.scrollHeight - els.messages.scrollTop;
      renderMessages(els.messageList, currentConv(), { unreadFrom });
      els.messages.scrollTop = els.messages.scrollHeight - fromBottom;
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    loadingOlder = false;
  }
}

// Someone's profile card, with ways to reach them.
export function showProfile(userId) {
  if (isMe(userId)) return openProfile(userId, { actions: [actionButton("gear", "Edit profile", () => (document.querySelector("dialog.profile")?.close(), settings()))] });
  const user = state.users.get(userId);
  if (!user) return;
  const dm = [...state.conversations.values()].find((c) => c.kind === "dm" && c.members.some((m) => m.id === userId));
  const actions = [];
  if (dm?.id !== state.current) {
    actions.push(actionButton("newChat", "Message", async () => {
      document.querySelector("dialog.profile")?.close();
      const conv = dm ?? (await api("/api/conversations", { method: "POST", body: { users: [user.name] } }));
      state.conversations.set(conv.id, conv);
      emit("conversations");
      location.hash = `#/c/${conv.id}`;
    }));
  }
  const close = () => document.querySelector("dialog.profile")?.close();
  if (dm) {
    actions.push(
      actionButton("phone", "Call", () => (close(), joinCall(dm.id, false))),
      actionButton("video", "Video", () => (close(), joinCall(dm.id, true))),
    );
    if (dm.id === state.current) actions.push(actionButton("palette", "Theme", () => (close(), themePicker(dm))));
  }
  openProfile(userId, { actions });
}

// Opens a chat if needed and scrolls to a message, loading older history
// until it's there, then makes it wiggle so it's easy to spot.
export async function jumpToMessage(c, id) {
  if (state.current !== c) {
    location.hash = `#/c/${c}`;
    for (let i = 0; i < 40 && !(state.current === c && thread(c).loaded); i++) await new Promise((r) => setTimeout(r, 100));
  }
  const t = thread(c);
  for (let pages = 0; !t.byId.has(id) && t.hasMore && pages < 40; pages++) {
    const first = t.messages.find((m) => !m.pending);
    if (!first) break;
    const { messages, hasMore } = await api(`/api/conversations/${c}/messages?before=${first.id}`);
    upsertMessages(c, messages);
    t.hasMore = hasMore;
  }
  if (state.current !== c) return;
  stick = false;
  renderMessages(els.messageList, currentConv(), { unreadFrom });
  const node = els.messageList.querySelector(`.msg[data-id="${id}"]`);
  if (!node) return toast("That message isn't there any more");
  node.scrollIntoView({ block: "center" });
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
}

function sendSticker(id, url) {
  const c = state.current;
  if (!c) return;
  const pending = { ...pendingMessage(c, "", null), kind: "sticker", meta: { sticker: id, url } };
  upsertMessages(c, [pending]);
  stick = true;
  renderList();
  post(c, { sticker: id, nonce: pending.nonce }, pending);
}

// Seen markers: tell the server once a chat is actually on screen.
export function markRead() {
  const conv = currentConv();
  if (!conv || document.visibilityState !== "visible" || !document.hasFocus()) return;
  const last = thread(conv.id).messages.findLast((m) => !m.pending);
  const mine = conv.members.find((m) => isMe(m.id));
  if (!last || !mine) return;
  if (conv.unread || mine.lastRead < last.id) {
    mine.lastRead = Math.max(mine.lastRead, last.id);
    conv.unread = 0;
    conv.mentioned = false;
    socket.send({ t: "read", c: conv.id, id: last.id });
    emit("conversations");
  }
}

// New messages, from the live connection or our own sends.

function previewOf(m) {
  return { id: m.id, user: m.user, kind: m.kind, body: m.body.slice(0, 200), meta: m.meta, attachment: m.attachments?.[0]?.kind ?? null, created: m.created, deleted: m.deleted };
}

export function receiveMessage(message, nonce) {
  const c = message.c;
  const conv = state.conversations.get(c);
  if (!conv) return;
  const t = state.threads.get(c);
  const known = Boolean(t?.byId.has(message.id)) || (conv.last && message.id <= conv.last.id);
  if (t?.loaded) {
    if (nonce) {
      const pending = t.messages.find((m) => m.nonce === nonce);
      if (pending) removeMessage(c, pending.id);
    }
    upsertMessages(c, [message]);
  }
  if (!conv.last || message.id >= conv.last.id) {
    conv.last = previewOf(message);
    conv.updated = message.created;
  }

  const typing = state.typing.get(c);
  if (typing?.has(message.user)) {
    clearTimeout(typing.get(message.user));
    typing.delete(message.user);
    if (state.current === c) renderHeader();
  }

  if (isMe(message.user)) {
    const mine = conv.members.find((m) => isMe(m.id));
    if (mine) mine.lastRead = Math.max(mine.lastRead, message.id);
  } else if (!known && message.kind !== "system") {
    const viewing = state.current === c && document.visibilityState === "visible" && document.hasFocus();
    if (!viewing) {
      conv.unread++;
      if (message.body.toLowerCase().includes(`@${state.me.name}`)) conv.mentioned = true;
      play("message");
      notify(conv, message);
    }
  }

  emit("conversations");
  if (state.current === c) {
    const follow = stick || isMe(message.user);
    renderMessages(els.messageList, conv, { unreadFrom });
    if (follow) {
      stick = true;
      toBottom(true);
    } else if (!known) {
      els.jump.hidden = false;
    }
    markRead();
  }
}

function notify(conv, message) {
  if (!document.hidden || local.get("notify") !== "on" || window.Notification?.permission !== "granted") return;
  const body = message.kind === "call" ? previewText({ ...conv, last: previewOf(message) }) : message.body || attachmentWord(message.attachments?.[0]?.kind);
  const n = new Notification(conv.kind === "dm" ? nameOf(message.user) : `${nameOf(message.user)} in ${titleOf(conv)}`, { body, tag: `chat-${conv.id}`, icon: "/apple-icon.png" });
  n.onclick = () => {
    focus();
    location.hash = `#/c/${conv.id}`;
    n.close();
  };
}

export function setTyping(c, userId) {
  if (!state.typing.has(c)) state.typing.set(c, new Map());
  const typing = state.typing.get(c);
  clearTimeout(typing.get(userId));
  typing.set(userId, setTimeout(() => {
    typing.delete(userId);
    refreshTyping(c);
  }, 5000));
  refreshTyping(c);
}

function refreshTyping(c) {
  emit("conversations");
  if (state.current === c) {
    renderHeader();
    renderList();
  }
}

export function redrawAll() {
  clearCache();
  if (state.current) {
    renderHeader();
    renderList();
  }
}

// The composer

function autosize() {
  const input = els.composerInput;
  input.style.height = "auto";
  // While hidden it has no height to measure; leave it at one line.
  if (input.scrollHeight) input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function updateButtons() {
  const hasContent = Boolean(els.composerInput.value.trim()) || composer.uploads.length > 0 || composer.mode?.type === "edit";
  els.send.hidden = !hasContent && canRecord();
  els.mic.hidden = hasContent || !canRecord();
}

function setMode(mode) {
  const wasEdit = composer.mode?.type === "edit";
  composer.mode = mode;
  if (!mode) {
    els.composerBar.hidden = true;
    if (wasEdit) els.composerInput.value = "";
  } else {
    const m = mode.m;
    const label = mode.type === "edit" ? h("strong", {}, "Editing") : h("strong", {}, `Replying to ${isMe(m.user) ? "yourself" : nameOf(m.user)}`);
    const snippet = m.body || attachmentWord(m.attachments?.[0]?.kind);
    els.composerBar.replaceChildren(
      icon(mode.type === "edit" ? "pencil" : "reply", "mid"),
      h("span", {}, label, " ", snippet),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Cancel", onclick: () => setMode(null) }, icon("close", "mid")),
    );
    els.composerBar.hidden = false;
    if (mode.type === "edit") els.composerInput.value = m.body;
    els.composerInput.focus();
  }
  autosize();
  updateButtons();
}

function resetComposer() {
  for (const item of composer.uploads) item.abort?.();
  composer.uploads = [];
  composer.mode = null;
  if (els.composerInput) {
    els.composerInput.value = "";
    els.composerBar.hidden = true;
    renderTray();
    autosize();
    updateButtons();
  }
}

// Photos are shrunk to a sensible size before uploading. JPEGs are always
// redrawn, which also strips their location and camera details.
async function prepare(file) {
  if (file.type.startsWith("video/")) return { blob: file, name: file.name, meta: await videoSize(file) };
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return { blob: file, name: file.name, meta: null };
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { blob: file, name: file.name, meta: null };
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const hgt = Math.round(bitmap.height * scale);
  if (file.type !== "image/jpeg" && scale === 1) return { blob: file, name: file.name, meta: { w, h: hgt } };
  const canvas = h("canvas", { width: w, height: hgt });
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, hgt);
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.86));
  const name = type === "image/jpeg" ? file.name.replace(/\.[^.]+$/, "") + ".jpg" : file.name;
  return { blob: blob ?? file, name, meta: { w, h: hgt } };
}

function videoSize(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (size) => {
      URL.revokeObjectURL(url);
      resolve(size);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => done(video.videoWidth ? { w: video.videoWidth, h: video.videoHeight } : null);
    video.onerror = () => done(null);
    setTimeout(() => done(null), 3000);
    video.src = url;
  });
}

function addFiles(files) {
  for (const file of files) {
    if (composer.uploads.length >= MAX_FILES) {
      toast(`Up to ${MAX_FILES} files per message`);
      break;
    }
    if (file.size > state.me.maxMb * 1000 * 1000) {
      toast(`${file.name} is bigger than ${state.me.maxMb} MB`, true);
      continue;
    }
    const item = { file, att: null, error: null, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null };
    item.progress = h("progress", { max: "1", value: "0" });
    item.done = prepare(file)
      .then(({ blob, name, meta }) => {
        const job = upload(blob, { name, fields: meta ? { meta: JSON.stringify(meta) } : {}, onProgress: (p) => (item.progress.value = p) });
        item.abort = job.abort;
        return job.done;
      })
      .then((att) => {
        item.att = att;
        item.progress.hidden = true;
      })
      .catch((err) => {
        item.error = err;
        item.node?.classList.add("failed");
        if (err.message !== "Cancelled") toast(`${file.name}: ${err.message}`, true);
      });
    composer.uploads.push(item);
  }
  renderTray();
  updateButtons();
  els.composerInput.focus();
}

function renderTray() {
  els.tray.hidden = composer.uploads.length === 0;
  els.tray.replaceChildren(...composer.uploads.map((item) => {
    item.node ??= h("div", { class: `tray-item${item.error ? " failed" : ""}`, title: item.file.name },
      item.preview ? h("img", { src: item.preview, alt: "" }) : h("span", { class: "tray-name" }, icon("file"), item.file.name),
      item.progress,
      h("button", { class: "icon-btn remove", type: "button", "aria-label": `Remove ${item.file.name}`, onclick: () => {
        item.abort?.();
        if (item.preview) URL.revokeObjectURL(item.preview);
        composer.uploads = composer.uploads.filter((u) => u !== item);
        renderTray();
        updateButtons();
      } }, icon("close")),
    );
    return item.node;
  }));
}

let nonceCount = 0;
const newNonce = () => `${Date.now().toString(36)}-${(nonceCount++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function pendingMessage(c, body, replyTo) {
  const nonce = newNonce();
  return {
    id: `tmp-${nonce}`,
    nonce,
    pending: true,
    c,
    user: state.me.id,
    kind: "text",
    body,
    replyTo: replyTo ? { id: replyTo.id, user: replyTo.user, body: replyTo.body, attachment: replyTo.attachments?.[0]?.kind ?? null } : null,
    created: Date.now(),
    attachments: [],
    reactions: [],
  };
}

async function send() {
  const c = state.current;
  if (!c) return;
  const text = els.composerInput.value.trim();

  if (composer.mode?.type === "edit") {
    const m = composer.mode.m;
    if (text === m.body) return setMode(null);
    try {
      const updated = await api(`/api/messages/${m.id}`, { method: "PATCH", body: { text } });
      upsertMessages(c, [updated]);
      setMode(null);
      renderList();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  // "/watch <YouTube link>" puts a video on for everyone; "/watch stop" ends it.
  const command = text.match(/^\/watch(?:\s+(.*))?$/i);
  if (command && !composer.uploads.length) {
    const arg = (command[1] ?? "").trim();
    if (/^stop$/i.test(arg)) stopWatch(c);
    else if (youTubeId(arg)) startWatch(c, youTubeId(arg));
    else return toast("Type /watch and a YouTube link, or /watch stop", true);
    els.composerInput.value = "";
    autosize();
    updateButtons();
    return;
  }

  const items = composer.uploads;
  if (!text && !items.length) return;
  const replyTo = composer.mode?.type === "reply" ? composer.mode.m : null;
  composer.uploads = [];
  composer.mode = null;
  els.composerInput.value = "";
  els.composerBar.hidden = true;
  renderTray();
  autosize();
  updateButtons();

  const waiting = items.length ? `Sending ${items.length === 1 ? attachmentWord(items[0].file.type.split("/")[0]).toLowerCase() : `${items.length} files`}…` : "";
  const pending = pendingMessage(c, text || waiting, replyTo);
  upsertMessages(c, [pending]);
  stick = true;
  if (state.current === c) renderList();

  await Promise.all(items.map((i) => i.done));
  for (const i of items) if (i.preview) URL.revokeObjectURL(i.preview);
  const keys = items.filter((i) => i.att).map((i) => i.att.key);
  if (!text && !keys.length) {
    removeMessage(c, pending.id);
    if (state.current === c) renderList();
    return;
  }
  pending.body = text;
  post(c, { text, attachments: keys, replyTo: replyTo?.id ?? null, nonce: pending.nonce }, pending);
}

async function post(c, body, pending) {
  pending.request = body;
  try {
    const message = await api(`/api/conversations/${c}/messages`, { method: "POST", body });
    play("sent");
    receiveMessage(message, body.nonce);
  } catch (err) {
    pending.failed = true;
    upsertMessages(c, [pending]);
    toast(err.message, true);
    if (state.current === c) renderList();
  }
}

function retry(m) {
  removeMessage(m.c, m.id);
  const again = pendingMessage(m.c, m.body, null);
  again.replyTo = m.replyTo;
  upsertMessages(m.c, [again]);
  renderList();
  post(m.c, { ...m.request, nonce: again.nonce }, again);
}

async function recordVoice() {
  const c = state.current;
  let recording;
  try {
    recording = await record(els.composerRow);
  } catch (err) {
    return toast(err.name === "NotAllowedError" ? "Allow the microphone to record voice messages" : "Couldn't start recording", true);
  }
  if (!recording) return;
  const replyTo = composer.mode?.type === "reply" ? composer.mode.m : null;
  setMode(null);
  const pending = pendingMessage(c, "Sending voice message…", replyTo);
  upsertMessages(c, [pending]);
  stick = true;
  if (state.current === c) renderList();
  try {
    const att = await upload(recording.blob, {
      purpose: "voice",
      name: recording.name,
      fields: { meta: JSON.stringify({ duration: recording.duration, peaks: recording.peaks }) },
    }).done;
    pending.body = "";
    post(c, { text: "", attachments: [att.key], replyTo: replyTo?.id ?? null, nonce: pending.nonce }, pending);
  } catch (err) {
    removeMessage(c, pending.id);
    if (state.current === c) renderList();
    toast(err.message, true);
  }
}
