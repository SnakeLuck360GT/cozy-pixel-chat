// Starts the app: loads you, everyone and your chats, draws the chat list,
// and keeps it all up to date from the live connection.

import { api } from "/js/api.js";
import { avatar, chatAvatar } from "/js/avatar.js";
import { $, h, shortTime } from "/js/dom.js";
import { art, icon } from "/js/icons.js";
import { initCalls } from "/js/calls.js";
import { initStage, renderStage } from "/js/stage.js";
import { initWatch, setWatch } from "/js/watch.js";
import {
  closeConversation, initChat, jumpToMessage, markRead, showProfile, openConversation, receiveMessage, redrawAll, renderHeader, renderList, setTyping,
} from "/js/chat.js";
import { joinDialog, newChat, settings } from "/js/panels.js";
import { talkScene } from "/js/scene.js";
import { openSearch } from "/js/search.js";
import * as socket from "/js/socket.js";
import { setSounds } from "/js/sound.js";
import { isMe, on, partnerOf, previewText, sortedConversations, state, titleOf, upsertMessages } from "/js/store.js";
import { applyFont, applyTheme } from "/js/themes.js";

const me = await api("/api/me");
if (me.needsTerms) {
  location.href = "/terms?next=/";
  await new Promise(() => {});
}
state.me = me;
applyTheme(me.prefs.theme);
applyFont(me.prefs.font);
setSounds(me.prefs.sounds);

await loadEverything();

const go = (c) => (location.hash = `#/c/${c}`);

$("brand").prepend(art("bubble"));
$("new-chat").append(icon("newChat"));
$("search-all").append(icon("search"));
$("search-all").onclick = () => openSearch({ onJump: jumpToMessage });
$("new-chat").onclick = () => newChat(go);
$("settings").append(icon("gear"));
$("settings").onclick = settings;
$("me-avatar").onclick = () => showProfile(state.me.id);
$("empty-art").append(talkScene());
$("empty-new").onclick = () => newChat(go);
$("attach").append(icon("plus"));
$("mic").append(icon("mic"));
$("send").append(icon("send"));
$("jump").append(icon("download", "mid"), "New messages");

initChat();
initCalls();
initWatch();
initStage();
on("conversations", renderSidebar);
on("calls", () => {
  renderStage();
  renderHeader();
  renderSidebar();
  renderList();
});
on("watch", renderStage);
on("me", () => {
  state.users.set(state.me.id, { ...state.users.get(state.me.id), ...state.me });
  renderMe();
  redrawAll();
});
addEventListener("hashchange", route);
route();
renderMe();
document.body.classList.remove("loading");

async function loadEverything() {
  const [users, conversations] = await Promise.all([api("/api/users"), api("/api/conversations")]);
  state.users = new Map(users.map((u) => [u.id, u]));
  state.online = new Set(users.filter((u) => u.online).map((u) => u.id));
  state.conversations = new Map(conversations.map((c) => [c.id, c]));
  state.calls = new Map(conversations.filter((c) => c.call).map((c) => [c.id, c.call]));
  state.watch.clear();
  for (const c of conversations) if (c.watch) setWatch(c.id, c.watch, c.watch.now);
}

function route() {
  // Invite links (#/join/<code>) ask before joining, then open the chat.
  const invite = location.hash.match(/^#\/join\/([a-z0-9]{6,16})$/);
  if (invite) {
    history.replaceState(null, "", "#/");
    joinDialog(invite[1], go);
  }
  const match = location.hash.match(/^#\/c\/(\d+)$/);
  const c = match ? Number(match[1]) : null;
  const open = c !== null && state.conversations.has(c);
  $("app").classList.toggle("in-chat", open);
  if (open) openConversation(c);
  else {
    if (c !== null) history.replaceState(null, "", "#/");
    closeConversation();
  }
  renderSidebar();
}

// The chat list

function renderSidebar() {
  const list = $("conv-list");
  const conversations = sortedConversations();
  if (!conversations.length) {
    list.replaceChildren(h("li", { class: "list-empty" },
      h("p", {}, "No chats yet."),
      h("button", { class: "btn", type: "button", onclick: () => newChat(go) }, "Start a chat"),
    ));
  } else {
    list.replaceChildren(...conversations.map(conversationItem));
  }
  const unread = conversations.reduce((sum, c) => sum + (c.unread ? 1 : 0), 0);
  document.title = unread ? `(${unread}) chat` : "chat";
}

function conversationItem(conv) {
  const partner = partnerOf(conv);
  const typing = state.typing.get(conv.id)?.size > 0;
  return h("li", {}, h("a", {
    class: `conv${conv.unread ? " unread" : ""}`,
    href: `#/c/${conv.id}`,
    "aria-current": state.current === conv.id ? "page" : null,
  },
  chatAvatar(conv, partner, 40, { online: Boolean(partner && state.online.has(partner.id)) }),
  h("span", { class: "conv-text" },
    h("span", { class: "conv-top" },
      h("span", { class: "conv-name" }, titleOf(conv)),
      state.calls.has(conv.id) ? h("span", { class: "conv-call", title: "A call is going" }, icon("phone", "small"), String(state.calls.get(conv.id).members.length)) : null,
      state.watch.has(conv.id) ? h("span", { class: "conv-call", title: "Watching together" }, icon("tv", "small")) : null,
      h("span", { class: "conv-time" }, conv.last ? shortTime(conv.last.created) : ""),
    ),
    h("span", { class: "conv-bottom" },
      h("span", { class: "conv-preview" }, typing ? "typing…" : previewText(conv)),
      conv.unread ? h("span", { class: "badge", "aria-label": `${conv.unread} unread` }, conv.mentioned ? "@" : String(Math.min(conv.unread, 99))) : null,
    ),
  )));
}

function renderMe() {
  $("me-avatar").replaceChildren(avatar(state.me, 40));
  $("me-name").textContent = state.me.displayName;
  $("me-handle").textContent = `@${state.me.name}`;
}

// Live updates

let firstOpen = true;

socket.on("open", async () => {
  if (firstOpen) {
    firstOpen = false;
    return;
  }
  // Back after a dropped connection: catch up on anything missed.
  await loadEverything();
  for (const [c, t] of state.threads) {
    if (!state.conversations.has(c)) {
      state.threads.delete(c);
      continue;
    }
    const last = t.messages.findLast((m) => !m.pending);
    if (!t.loaded || !last) continue;
    const { messages } = await api(`/api/conversations/${c}/messages?after=${last.id}`);
    upsertMessages(c, messages);
  }
  if (state.current && !state.conversations.has(state.current)) location.hash = "#/";
  redrawAll();
  renderSidebar();
  renderStage();
  markRead();
});

socket.on("hello", ({ online }) => {
  state.online = new Set(online);
  renderSidebar();
  renderHeader();
});

socket.on("message", ({ message, nonce }) => receiveMessage(message, nonce));

socket.on("message-update", ({ message }) => {
  const t = state.threads.get(message.c);
  if (t?.byId.has(message.id)) upsertMessages(message.c, [message]);
  const conv = state.conversations.get(message.c);
  if (conv?.last?.id === message.id) {
    conv.last = { ...conv.last, body: message.body.slice(0, 200), deleted: message.deleted, attachment: message.attachments[0]?.kind ?? null };
  }
  renderSidebar();
  if (state.current === message.c) renderList();
});

socket.on("conversation", ({ conversation }) => {
  const before = state.conversations.get(conversation.id);
  state.conversations.set(conversation.id, conversation);
  if (state.current === conversation.id) {
    if (before?.theme !== conversation.theme) applyTheme(conversation.theme);
    redrawAll();
    markRead();
  }
  renderSidebar();
});

socket.on("conversation-removed", ({ id }) => {
  state.conversations.delete(id);
  state.threads.delete(id);
  if (state.current === id) location.hash = "#/";
  renderSidebar();
});

socket.on("read", ({ c, user, id }) => {
  const conv = state.conversations.get(c);
  const member = conv?.members.find((m) => m.id === user);
  if (!member) return;
  member.lastRead = Math.max(member.lastRead, id);
  // Read on another of your devices.
  if (isMe(user) && (!conv.last || id >= conv.last.id)) {
    conv.unread = 0;
    conv.mentioned = false;
  }
  renderSidebar();
  if (state.current === c) renderList();
});

socket.on("typing", ({ c, user }) => setTyping(c, user));

socket.on("presence", ({ user, online, lastSeen }) => {
  if (online) state.online.add(user);
  else state.online.delete(user);
  const u = state.users.get(user);
  if (u) Object.assign(u, { online, lastSeen });
  renderSidebar();
  renderHeader();
});

socket.on("user", ({ user }) => {
  state.users.set(user.id, user);
  if (isMe(user.id)) Object.assign(state.me, user);
  renderMe();
  renderSidebar();
  redrawAll();
});

socket.on("user-removed", ({ id }) => {
  state.users.delete(id);
  renderSidebar();
  redrawAll();
});

socket.connect();

// Keeps "5m ago" style times fresh.
setInterval(() => {
  renderSidebar();
  renderHeader();
}, 60_000);
