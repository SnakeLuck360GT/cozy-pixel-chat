// Admin page: overview, invite codes, accounts, the upload limit, and (for
// the owner) recent uploads with their IP addresses.

import { api } from "/js/api.js";
import { avatar } from "/js/avatar.js";
import { $, agoText, formatBytes, h, toast } from "/js/dom.js";
import { art } from "/js/icons.js";
import { serverRows } from "/js/stage.js";
import { applyTheme } from "/js/themes.js";
import { confirmBox } from "/js/ui.js";

const me = await api("/api/me");
if (!me.admin) location.replace("/");
applyTheme(me.prefs.theme);
$("brand").prepend(art("bubble"));
$("user-admin-wrap").hidden = !me.owner;
$("uploads-section").hidden = !me.owner;
document.body.classList.remove("loading");

const date = (t) => (t ? new Date(t).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "Never");
const row = (...cells) => h("tr", {}, cells.map((c) => h("td", {}, c)));
const head = (...labels) => h("tr", {}, labels.map((l) => h("th", {}, l)));

function secret(label, text, extra) {
  const copy = h("button", { class: "btn plain", type: "button", onclick: () => navigator.clipboard.writeText(text).then(() => toast("Copied")) }, "Copy");
  return h("div", { class: "secret" }, h("div", {}, label), h("strong", {}, text), extra ?? null, h("div", { class: "actions" }, copy));
}

async function loadOverview() {
  const o = await api("/api/admin/overview");
  const stat = (value, label) => h("div", { class: "stat" }, h("b", {}, String(value)), h("span", {}, label));
  $("stats").replaceChildren(
    stat(o.users, "Accounts"),
    stat(o.online, "Online now"),
    stat(o.conversations, "Chats"),
    stat(o.messages, "Messages"),
    stat(o.files, "Files"),
    stat(formatBytes(o.bytes), "Stored"),
    stat(formatBytes(o.diskFree), "Disk free"),
  );
  $("max-mb").value = o.maxMb;
}

async function loadInvites() {
  const invites = await api("/api/invites");
  $("invites").replaceChildren(
    head("Code", "Uses left", "Expires", "Made by", "Used by", ""),
    ...invites.map((i) => row(
      `${i.hint}-…`,
      String(i.usesLeft),
      i.expires ? date(i.expires) : "Never",
      i.createdBy,
      i.usedBy.join(", ") || "Nobody yet",
      h("button", { class: "btn plain", type: "button", onclick: async () => {
        await api(`/api/invites/${i.id}`, { method: "DELETE" });
        loadInvites();
      } }, "Revoke"),
    )),
  );
  if (!invites.length) $("invites").replaceChildren(row(h("span", { class: "dim" }, "No invite codes yet.")));
}

$("invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const invite = await api("/api/invites", { method: "POST", body: { uses: $("invite-uses").value, days: $("invite-days").value } });
    const link = `${location.origin}/signup?code=${invite.code}`;
    $("new-invite").replaceChildren(secret("New invite code. It's only shown once, so copy the link now:", link));
    loadInvites();
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadUsers() {
  const users = await api("/api/admin/users");
  const actions = (u) => {
    if (!me.owner || u.id === me.id) return "";
    return h("div", { class: "row-actions" },
      h("button", { class: "btn plain", type: "button", onclick: async () => {
        if (!(await confirmBox(`Make a new password for ${u.name}? They'll be logged out everywhere.`, { ok: "Reset" }))) return;
        const { password } = await api(`/api/users/${u.name}/reset`, { method: "POST", body: {} });
        $("new-user").replaceChildren(secret(`New password for ${u.name}:`, password));
      } }, "Reset password"),
      h("button", { class: "btn plain", type: "button", onclick: async () => {
        await api(`/api/users/${u.name}/admin`, { method: "POST", body: { admin: u.role !== "admin" } });
        loadUsers();
      } }, u.role === "admin" ? "Remove admin" : "Make admin"),
      h("button", { class: "btn danger", type: "button", onclick: async () => {
        const ok = await confirmBox(`This deletes ${u.name}, everything they've sent, and their one-to-one chats. It can't be undone.`, { title: `Delete ${u.name}?`, ok: "Delete", danger: true });
        if (!ok) return;
        await api(`/api/users/${u.name}`, { method: "DELETE" }).catch((err) => toast(err.message, true));
        loadUsers();
        loadOverview();
      } }, "Delete"),
    );
  };
  $("users").replaceChildren(
    head("", "Account", "Role", "Last seen", "Messages", "Files", ""),
    ...users.map((u) => row(
      avatar(u, 32, { online: u.online }),
      h("span", {}, h("strong", {}, u.displayName), h("br"), h("small", { class: "dim" }, `@${u.name}`)),
      u.role,
      u.online ? "Online" : agoText(u.lastSeen).replace("Active ", ""),
      String(u.messages),
      formatBytes(u.bytes),
      actions(u),
    )),
  );
}

$("user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const { name, password } = await api("/api/users", { method: "POST", body: { name: $("user-name").value, admin: $("user-admin").checked } });
    $("new-user").replaceChildren(secret(`Account made. Password for ${name} (they can change it in Settings):`, password));
    e.target.reset();
    loadUsers();
    loadOverview();
  } catch (err) {
    toast(err.message, true);
  }
});

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/settings", { method: "PUT", body: { maxMb: $("max-mb").value } });
    toast("Saved");
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadUploads() {
  const uploads = await api("/api/admin/uploads");
  $("uploads").replaceChildren(
    head("File", "Kind", "Size", "By", "IP", "When"),
    ...uploads.map((u) => row(
      h("a", { href: u.url, target: "_blank", rel: "noopener noreferrer" }, u.name),
      u.kind + (u.sent || u.kind === "avatar" ? "" : " (not sent)"),
      formatBytes(u.size),
      u.user ?? "deleted",
      u.ip ?? "",
      date(u.created),
    )),
  );
}

// Pixel bars for CPU, memory and disk, then the details.
function meter(label, fraction, text) {
  const bar = h("span", { class: "meter-bar" });
  const fill = h("i");
  fill.style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
  bar.append(fill);
  bar.classList.toggle("high", fraction > 0.85);
  return h("div", { class: "meter" }, h("span", { class: "meter-label" }, label, h("strong", {}, text)), bar);
}

async function loadSystem() {
  const s = await api("/api/admin/system");
  const pct = (n) => `${Math.round(n * 100)}%`;
  $("meters").replaceChildren(
    meter("CPU", (s.cpu ?? 0) / 100, s.cpu === null ? "…" : `${s.cpu}%`),
    meter("Memory", s.memory.used / s.memory.total, pct(s.memory.used / s.memory.total)),
    meter("Disk", s.disk.used / s.disk.total, pct(s.disk.used / s.disk.total)),
  );
  $("system").replaceChildren(...serverRows(s));
}

await Promise.all([loadOverview(), loadInvites(), loadUsers(), loadSystem(), me.owner ? loadUploads() : null]);
setInterval(() => loadSystem().catch(() => {}), 3000);
