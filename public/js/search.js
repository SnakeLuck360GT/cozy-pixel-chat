// Finding messages: search (one chat or all of them, text and file names)
// and a chat's pinned messages. Picking one jumps to it in the chat.

import { api } from "/js/api.js";
import { avatar } from "/js/avatar.js";
import { dayLabel, h, toast } from "/js/dom.js";
import { icon } from "/js/icons.js";
import { attachmentWord, isMe, nameOf, state, titleOf, userOf } from "/js/store.js";
import { openWindow } from "/js/ui.js";

// The text around the first match, with every match marked.
function highlighted(text, query) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const first = q ? lower.indexOf(q) : -1;
  const start = first > 60 ? first - 50 : 0;
  const part = (start ? "…" : "") + text.slice(start, start + 220);
  const node = h("span", { class: "result-text" });
  if (!q) {
    node.append(part);
    return node;
  }
  let at = 0;
  const partLower = part.toLowerCase();
  for (let i = partLower.indexOf(q); i !== -1; i = partLower.indexOf(q, at)) {
    node.append(part.slice(at, i), h("mark", {}, part.slice(i, i + q.length)));
    at = i + q.length;
  }
  node.append(part.slice(at));
  return node;
}

function resultRow(m, { query = "", showChat = false, onJump, extra }) {
  const conv = state.conversations.get(m.c);
  const files = m.attachments.map((a) => a.name).join(", ");
  const body = m.body || (m.kind === "sticker" ? "Sticker" : files ? "" : attachmentWord(m.attachments[0]?.kind));
  return h("li", { class: "result" },
    h("button", { class: "result-main", type: "button", onclick: () => onJump(m) },
      avatar(userOf(m.user) ?? (isMe(m.user) ? state.me : { name: "?" }), 32),
      h("span", {},
        h("span", { class: "result-top" },
          h("strong", {}, nameOf(m.user)),
          showChat && conv ? h("span", {}, ` in ${titleOf(conv)}`) : null,
          h("small", {}, ` · ${dayLabel(m.created)}`),
        ),
        body ? highlighted(body, query) : null,
        files ? h("span", { class: "result-files" }, icon("file", "small"), highlighted(files, query)) : null,
      ),
    ),
    extra ?? null,
  );
}

export function openSearch({ c = null, onJump }) {
  let scope = c;
  const input = h("input", { type: "search", placeholder: "Search messages and file names", autocomplete: "off", "aria-label": "Search" });
  const list = h("ul", { class: "results" });
  const hint = (text) => list.replaceChildren(h("li", { class: "result-hint" }, text));
  const scopes = c
    ? h("div", { class: "segmented" },
      ...[[c, "This chat"], [null, "All chats"]].map(([value, label]) => {
        const b = h("button", { class: "btn plain", type: "button", "aria-pressed": String(scope === value) }, label);
        b.onclick = () => {
          scope = value;
          for (const other of scopes.children) other.setAttribute("aria-pressed", String(other === b));
          run();
        };
        return b;
      }))
    : null;

  let latest = 0;
  async function run() {
    const q = input.value.trim();
    if (q.length < 2) return hint("Type at least two letters.");
    const mine = ++latest;
    let results;
    try {
      results = await api(`/api/search?q=${encodeURIComponent(q)}${scope ? `&c=${scope}` : ""}`);
    } catch (err) {
      return hint(err.message);
    }
    if (mine !== latest) return;
    if (!results.length) return hint("Nothing found.");
    list.replaceChildren(...results.map((m) => resultRow(m, {
      query: q,
      showChat: !scope,
      onJump: (picked) => {
        dialog.close();
        onJump(picked.c, picked.id);
      },
    })));
  }

  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  };
  hint("Type at least two letters.");
  const dialog = openWindow({ title: "Search", className: "wide", body: [h("label", { class: "field" }, input), scopes, list] });
  input.focus();
}

export async function openPins(conv, { onJump }) {
  const list = h("ul", { class: "results" });
  const dialog = openWindow({ title: "Pinned", className: "wide", body: list });
  const draw = async () => {
    let pins;
    try {
      pins = await api(`/api/conversations/${conv.id}/pins`);
    } catch (err) {
      return toast(err.message, true);
    }
    if (!pins.length) {
      list.replaceChildren(h("li", { class: "result-hint" }, "Nothing pinned yet. Pin a message from its menu (the three dots, or hold it on a phone)."));
      return;
    }
    list.replaceChildren(...pins.map((m) => resultRow(m, {
      onJump: (picked) => {
        dialog.close();
        onJump(picked.c, picked.id);
      },
      extra: h("button", { class: "btn plain", type: "button", onclick: async () => {
        await api(`/api/messages/${m.id}/pin`, { method: "PUT", body: { pinned: false } }).catch((err) => toast(err.message, true));
        draw();
      } }, "Unpin"),
    })));
  };
  draw();
}
