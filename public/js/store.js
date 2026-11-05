// What the app knows: you, everyone else, your chats, and the messages
// loaded so far. Modules change it and then call emit() so views redraw.

import { duration } from "/js/dom.js";
import { themeName } from "/js/themes.js";

export const state = {
  me: null,
  users: new Map(),
  conversations: new Map(),
  online: new Set(),
  // Conversation id -> { messages: [], byId: Map, hasMore, loaded }
  threads: new Map(),
  // Conversation id -> Map(user id -> timeout)
  typing: new Map(),
  // Conversation id -> the call going there ({ members, video, started, aloneUntil })
  calls: new Map(),
  // Conversation id -> what's being watched together there
  watch: new Map(),
  current: null,
};

const bus = new EventTarget();
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

export const userOf = (id) => state.users.get(id);
export const isMe = (id) => id === state.me.id;
export const nameOf = (id) => (isMe(id) ? state.me.displayName : (userOf(id)?.displayName ?? "Someone"));

export const others = (conv) => conv.members.map((m) => m.id).filter((id) => !isMe(id));
export const partnerOf = (conv) => (conv.kind === "dm" ? userOf(others(conv)[0]) : null);

export function titleOf(conv) {
  if (conv.kind === "server") return conv.name || "Server";
  if (conv.kind === "group") return conv.name || others(conv).map(nameOf).join(", ") || "Just you";
  return nameOf(others(conv)[0]);
}

export const sortedConversations = () => [...state.conversations.values()].sort((a, b) => b.updated - a.updated);

function list(ids) {
  const names = ids.map((id) => (isMe(id) ? "you" : nameOf(id)));
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "someone");
}

// The small centred notes: "Sam changed the theme to Autumn".
export function systemText(m) {
  const who = isMe(m.user) ? "You" : nameOf(m.user);
  const meta = m.meta ?? {};
  switch (meta.action) {
    case "theme": return `${who} changed the theme to ${themeName(meta.theme)}`;
    case "rename": return meta.name ? `${who} named the group "${meta.name}"` : `${who} removed the group name`;
    case "create": return `${who} started this`;
    case "add": return `${who} added ${list(meta.users ?? [])}`;
    case "remove": return `${who} removed ${list(meta.users ?? [])}`;
    case "leave": return `${who} left the group`;
    case "watch": return `${who} put on a video to watch together`;
    case "pin": return `${who} pinned a message`;
    case "icon": return `${who} changed the picture`;
    case "join": return `${who} joined`;
    default: return "";
  }
}

export function callText(m) {
  const { video, status, duration: ms } = m.meta ?? {};
  const kind = video ? "Video call" : "Voice call";
  if (status === "ended") return { title: kind, detail: duration(ms), missed: false };
  if (status === "declined") return { title: kind, detail: "Declined", missed: true };
  return { title: isMe(m.user) ? kind : `Missed ${kind.toLowerCase()}`, detail: isMe(m.user) ? "No answer" : "Tap to call back", missed: !isMe(m.user) };
}

const ATTACHMENT_WORDS = { image: "Photo", video: "Video", audio: "Audio", voice: "Voice message", file: "File" };

export function previewText(conv) {
  const m = conv.last;
  if (!m) return conv.kind === "group" ? "New group" : "Say hello";
  if (m.kind === "system") return systemText(m);
  if (m.kind === "call") return callText(m).title + (m.meta?.status === "ended" ? ` · ${duration(m.meta.duration)}` : "");
  const prefix = isMe(m.user) ? "You: " : conv.kind === "group" ? `${nameOf(m.user)}: ` : "";
  if (m.deleted) return `${isMe(m.user) ? "You" : nameOf(m.user)} unsent a message`;
  if (m.kind === "sticker") return `${prefix}Sticker`;
  return prefix + (m.body || ATTACHMENT_WORDS[m.attachment] || "Attachment");
}

export const attachmentWord = (kind) => ATTACHMENT_WORDS[kind] ?? "Attachment";

export function thread(c) {
  if (!state.threads.has(c)) state.threads.set(c, { messages: [], byId: new Map(), hasMore: true, loaded: false });
  return state.threads.get(c);
}

// Adds or replaces messages, keeping them in order.
export function upsertMessages(c, messages) {
  const t = thread(c);
  for (const m of messages) t.byId.set(m.id, m);
  // Messages still sending go after everything the server has confirmed.
  const all = [...t.byId.values()];
  t.messages = [
    ...all.filter((m) => !m.pending).sort((a, b) => a.id - b.id),
    ...all.filter((m) => m.pending).sort((a, b) => a.created - b.created),
  ];
}

export function removeMessage(c, id) {
  const t = thread(c);
  t.byId.delete(id);
  t.messages = t.messages.filter((m) => m.id !== id);
}
