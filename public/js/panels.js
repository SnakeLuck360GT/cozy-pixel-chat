// The windows: settings, the theme picker, starting a chat, chat details
// and the photo viewer.

import { api, upload } from "/js/api.js";
import { avatar, chatAvatar } from "/js/avatar.js";
import { agoText, h, local, toast } from "/js/dom.js";
import { icon } from "/js/icons.js";
import { setSounds } from "/js/sound.js";
import { emit, isMe, nameOf, others, partnerOf, state, titleOf, userOf } from "/js/store.js";
import { THEMES, applyFont, applyTheme } from "/js/themes.js";
import { setWeatherEnabled, weatherEnabled } from "/js/weather.js";
import { BADGES, COLOURS, MAX_BADGES, badgeIcon, openProfile } from "/js/profile.js";
import { confirmBox, openWindow } from "/js/ui.js";

function swatch(theme, chosen, onPick) {
  return h("button", { class: "swatch", type: "button", "data-theme": theme.id, "aria-pressed": String(chosen), title: theme.note, onclick: () => onPick(theme.id) },
    h("span", { class: "swatch-scene" }, h("i"), h("i")),
    h("span", { class: "swatch-name" }, theme.name, chosen ? icon("check", "mid") : null),
  );
}

// Instagram-style: the theme belongs to the chat, so both people see it.
export function themePicker(conv) {
  const grid = h("div", { class: "themes" });
  const draw = () => grid.replaceChildren(...THEMES.map((t) => swatch(t, t.id === conv.theme, pick)));
  async function pick(theme) {
    if (theme === conv.theme) return dialog.close();
    const before = conv.theme;
    conv.theme = theme;
    applyTheme(theme);
    draw();
    try {
      await api(`/api/conversations/${conv.id}`, { method: "PATCH", body: { theme } });
      dialog.close();
    } catch (err) {
      conv.theme = before;
      applyTheme(before);
      draw();
      toast(err.message, true);
    }
  }
  draw();
  const dialog = openWindow({
    title: "Chat theme",
    className: "wide",
    body: [h("p", { class: "dim" }, conv.kind === "dm" ? `You and ${titleOf(conv)} will both see it.` : "Everyone in the group will see it."), grid],
  });
}

export function settings() {
  const me = state.me;
  const status = h("p", { class: "status", role: "status" });

  // Profile
  const picture = h("span", {}, avatar(me, 96));
  const fileInput = h("input", { type: "file", accept: "image/*", hidden: true });
  const remove = h("button", { class: "btn plain", type: "button", hidden: !me.avatar }, "Remove");
  const name = h("input", { id: "display-name", maxlength: "40", autocomplete: "nickname", value: me.displayName === me.name ? "" : me.displayName, placeholder: me.name });

  const refreshProfile = (fresh) => {
    Object.assign(state.me, fresh);
    picture.replaceChildren(avatar(state.me, 96));
    remove.hidden = !state.me.avatar;
    emit("me");
  };

  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    try {
      // Animated GIFs go up as they are so they keep moving; the square crop
      // happens on screen instead.
      if (file.type === "image/gif" && file.size <= 2_000_000) {
        refreshProfile(await upload(file, { purpose: "avatar", name: "avatar.gif" }).done);
        return;
      }
      const square = await squareImage(file, 256);
      refreshProfile(await upload(square, { purpose: "avatar", name: "avatar.jpg" }).done);
    } catch (err) {
      toast(err.message, true);
    }
  };
  remove.onclick = async () => refreshProfile(await api("/api/me/avatar", { method: "DELETE" }));
  // Each field saves as soon as you leave it.
  const saveField = (field, label) => async (e) => {
    try {
      refreshProfile(await api("/api/me", { method: "PATCH", body: { [field]: e.target.value } }));
      toast(`${label} saved`);
    } catch (err) {
      toast(err.message, true);
    }
  };
  name.onchange = saveField("displayName", "Name");
  const pronouns = h("input", { maxlength: "40", value: me.pronouns ?? "", placeholder: "she/her, he/him, they/them…" });
  pronouns.onchange = saveField("pronouns", "Pronouns");
  const statusInput = h("input", { maxlength: "60", value: me.status ?? "", placeholder: "📚 studying, 🎮 gaming, 😴 asleep…" });
  statusInput.onchange = saveField("status", "Status");
  const bioCount = h("small", {}, `${(me.bio ?? "").length}/190`);
  const bio = h("textarea", { rows: "3", maxlength: "190", value: me.bio ?? "", placeholder: "A little about you" });
  bio.oninput = () => (bioCount.textContent = `${bio.value.length}/190`);
  bio.onchange = saveField("bio", "Bio");

  // The banner: a picture, or a colour if there isn't one.
  const bannerPreview = h("div", { class: "profile-banner small" });
  const drawBanner = () => {
    bannerPreview.replaceChildren(state.me.banner ? h("img", { src: state.me.banner, alt: "" }) : "");
    bannerPreview.style.background = state.me.banner ? "" : state.me.color || "";
    removeBanner.hidden = !state.me.banner;
  };
  const bannerInput = h("input", { type: "file", accept: "image/*", hidden: true });
  const removeBanner = h("button", { class: "btn plain", type: "button", onclick: async () => {
    refreshProfile(await api("/api/me/banner", { method: "DELETE" }));
    drawBanner();
  } }, "Remove");
  bannerInput.onchange = async () => {
    const file = bannerInput.files[0];
    bannerInput.value = "";
    if (!file) return;
    try {
      const wide = file.type === "image/gif" && file.size <= 4_000_000 ? file : await bannerImage(file);
      refreshProfile(await upload(wide, { purpose: "banner", name: file.type === "image/gif" ? "banner.gif" : "banner.jpg" }).done);
      drawBanner();
    } catch (err) {
      toast(err.message, true);
    }
  };
  const colours = h("div", { class: "colour-row" });
  const drawColours = () => colours.replaceChildren(...["", ...COLOURS].map((c) => {
    const b = h("button", { class: "colour", type: "button", "aria-label": c ? `Banner colour ${c}` : "Theme colour", "aria-pressed": String((state.me.color ?? "") === c) });
    if (c) b.style.background = c;
    b.onclick = async () => {
      refreshProfile(await api("/api/me", { method: "PATCH", body: { color: c } }));
      drawColours();
      drawBanner();
    };
    return b;
  }));

  // Badges: pick up to four.
  const badgeGrid = h("div", { class: "badge-picker" });
  const drawBadges = () => badgeGrid.replaceChildren(...BADGES.map((badge) => {
    const chosen = (state.me.badges ?? []).includes(badge.id);
    return h("button", { class: "badge-option", type: "button", "aria-pressed": String(chosen), onclick: async () => {
      const current = state.me.badges ?? [];
      const next = chosen ? current.filter((b) => b !== badge.id) : [...current, badge.id];
      if (next.length > MAX_BADGES) return toast(`Pick up to ${MAX_BADGES} badges`);
      try {
        refreshProfile(await api("/api/me", { method: "PATCH", body: { badges: next } }));
        drawBadges();
      } catch (err) {
        toast(err.message, true);
      }
    } }, badgeIcon(badge), h("span", {}, badge.name));
  }));
  drawBadges();
  queueMicrotask(() => {
    drawBanner();
    drawColours();
  });

  // Look
  const savePrefs = async (prefs) => {
    try {
      refreshProfile(await api("/api/me", { method: "PATCH", body: { prefs } }));
    } catch (err) {
      toast(err.message, true);
    }
  };
  const themeGrid = h("div", { class: "themes" });
  const drawThemes = () => themeGrid.replaceChildren(...THEMES.map((t) => swatch(t, t.id === state.me.prefs.theme, async (id) => {
    state.me.prefs.theme = id;
    if (!state.current) applyTheme(id);
    drawThemes();
    await savePrefs({ theme: id });
  })));
  drawThemes();

  const fontButtons = h("div", { class: "segmented" });
  const drawFont = () => fontButtons.replaceChildren(...[["pixel", "Pixel"], ["smooth", "Smooth"]].map(([id, label]) =>
    h("button", { class: "btn plain", type: "button", "aria-pressed": String(state.me.prefs.font === id), onclick: async () => {
      state.me.prefs.font = id;
      applyFont(id);
      drawFont();
      await savePrefs({ font: id });
    } }, label)));
  drawFont();

  const weather = h("input", { type: "checkbox", checked: weatherEnabled() });
  weather.onchange = () => setWeatherEnabled(weather.checked);
  const sounds = h("input", { type: "checkbox", checked: me.prefs.sounds });
  sounds.onchange = () => {
    setSounds(sounds.checked);
    savePrefs({ sounds: sounds.checked });
  };
  const notify = h("input", { type: "checkbox", checked: local.get("notify") === "on" && window.Notification?.permission === "granted" });
  notify.onchange = async () => {
    if (notify.checked) {
      const permission = window.Notification ? await Notification.requestPermission() : "denied";
      if (permission !== "granted") {
        notify.checked = false;
        return toast("Notifications are blocked for this site in your browser settings", true);
      }
    }
    local.set("notify", notify.checked ? "on" : "off");
  };

  // Password
  const current = h("input", { type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: "8", required: true });
  const passwordForm = h("form", {},
    h("label", { class: "field" }, h("span", {}, "Current password"), current),
    h("label", { class: "field" }, h("span", {}, "New password"), next, h("small", {}, "At least 8 characters. Your other devices get logged out.")),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, "Change password")),
    status,
  );
  passwordForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/me/password", { method: "POST", body: { current: current.value, next: next.value } });
      passwordForm.reset();
      status.className = "status";
      status.textContent = "Password changed.";
    } catch (err) {
      status.className = "status error";
      status.textContent = err.message;
    }
  };

  const logout = h("button", { class: "btn plain", type: "button", onclick: async () => {
    await api("/api/logout", { method: "POST", body: {} });
    location.href = "/login";
  } }, icon("logout", "mid"), "Log out");

  // One tab at a time, so phones aren't one endless scroll.
  const tabs = [
    ["Profile", [
      h("div", { class: "profile-row" }, picture, h("div", { class: "actions" },
        h("button", { class: "btn plain", type: "button", onclick: () => fileInput.click() }, "Change picture"), remove, fileInput)),
      h("label", { class: "field" }, h("span", {}, "Display name"), name, h("small", {}, `Shown instead of @${me.name}. Leave empty to use your username.`)),
      h("label", { class: "field" }, h("span", {}, "Pronouns"), pronouns),
      h("label", { class: "field" }, h("span", {}, "Status"), statusInput, h("small", {}, "Shows under your name in chats. Leave empty for none.")),
      h("label", { class: "field" }, h("span", {}, "Bio"), bio, bioCount),
      h("div", { class: "field" }, h("span", {}, "Banner"), bannerPreview,
        h("div", { class: "actions start" }, h("button", { class: "btn plain", type: "button", onclick: () => bannerInput.click() }, "Change banner"), removeBanner, bannerInput),
        h("small", {}, "Or a colour, shown when there's no banner picture:"), colours),
      h("div", { class: "field" }, h("span", {}, `Badges (up to ${MAX_BADGES})`), badgeGrid),
      h("div", { class: "actions start" }, h("button", { class: "btn plain", type: "button", onclick: () => openProfile(state.me.id) }, "Preview my profile")),
    ]],
    ["Look", [
      h("h3", { class: "section-title" }, "Your theme"),
      h("p", { class: "dim" }, "Used on the home screen and for new chats. Each chat can have its own."),
      themeGrid,
      h("label", { class: "check" }, weather, "Animated weather in the themes (snow, petals, leaves…) on this device"),
      h("h3", { class: "section-title" }, "Message text"),
      fontButtons,
    ]],
    ["Alerts", [
      h("h3", { class: "section-title" }, "Alerts"),
      h("label", { class: "check" }, sounds, "Little sounds for new messages"),
      h("label", { class: "check" }, notify, "Notifications on this device when the tab is in the background"),
    ]],
    ["Account", [
      h("h3", { class: "section-title" }, "Password"),
      passwordForm,
      h("h3", { class: "section-title" }, "Account"),
      h("div", { class: "actions start" },
        me.admin ? h("a", { class: "btn plain", href: "/admin" }, icon("shield", "mid"), "Admin") : null,
        h("a", { class: "btn plain", href: "/terms" }, "Terms"),
        logout,
      ),
    ]],
  ];
  const panes = tabs.map(([, content], i) => h("div", { hidden: i > 0 }, content));
  const tabBar = h("div", { class: "segmented window-tabs", role: "tablist" });
  const showTab = (index) => {
    tabBar.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String(i === index)));
    panes.forEach((pane, i) => (pane.hidden = i !== index));
    dialog.querySelector(".window-body").scrollTop = 0;
  };
  tabBar.append(...tabs.map(([label], i) => h("button", { class: "btn plain", type: "button", "aria-pressed": String(i === 0), onclick: () => showTab(i) }, label)));

  const dialog = openWindow({ title: "Settings", className: "wide settings", body: panes });
  dialog.querySelector(".window-title").after(tabBar);
}

// Crops to a centred 3:1 strip for banners, at 960×320.
async function bannerImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That picture couldn't be opened. Try a JPEG or PNG.");
  });
  const height = Math.min(bitmap.height, bitmap.width / 3);
  const width = height * 3;
  const canvas = h("canvas", { width: 960, height: 320 });
  canvas.getContext("2d").drawImage(bitmap, (bitmap.width - width) / 2, (bitmap.height - height) / 2, width, height, 0, 0, 960, 320);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
}

// Crops to a centred square and shrinks it, which also drops the photo's
// location and camera details.
async function squareImage(file, size) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That picture couldn't be opened. Try a JPEG or PNG.");
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = h("canvas", { width: size, height: size });
  canvas.getContext("2d").drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
}

function personRow(user, extra) {
  return [
    h("button", { class: "avatar-btn", type: "button", "aria-label": `${user.displayName}'s profile`, onclick: (e) => {
      e.preventDefault();
      openProfile(user.id);
    } }, avatar(user, 40, { online: state.online.has(user.id) })),
    h("span", {}, h("strong", {}, user.displayName), h("small", {}, `@${user.name}`)),
    extra,
  ];
}

// A chat: pick one person for a one-to-one chat, or several (plus a name)
// for a group. A server: a name, anyone to add now, and an invite link for later.
export function newChat(onOpen) {
  let server = false;
  const people = [...state.users.values()].filter((u) => !isMe(u.id)).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const boxes = people.map((u) => h("input", { type: "checkbox", value: u.name }));
  const groupName = h("input", { maxlength: "60", placeholder: "Optional" });
  const nameLabel = h("span", {}, "Group name");
  const groupField = h("label", { class: "field", hidden: true }, nameLabel, groupName);
  const start = h("button", { class: "btn", type: "submit", disabled: true }, "Start chat");
  const note = h("p", { class: "dim", hidden: true }, "Like a Discord server with one channel. Use it on your own to keep things, or invite people with its link.");
  const update = () => {
    const count = boxes.filter((b) => b.checked).length;
    groupField.hidden = !server && count < 2;
    nameLabel.textContent = server ? "Server name" : "Group name";
    groupName.placeholder = server ? "Like \"Recipes\" or \"Trip plans\"" : "Optional";
    groupName.required = server;
    note.hidden = !server;
    start.disabled = !server && count === 0;
    start.textContent = server ? "Create server" : count > 1 ? "Start group" : "Start chat";
  };
  boxes.forEach((b) => (b.onchange = update));
  const modes = h("div", { class: "segmented" }, [["Chat", false], ["Server", true]].map(([label, value]) => {
    const b = h("button", { class: "btn plain", type: "button", "aria-pressed": String(value === server) }, label);
    b.onclick = () => {
      server = value;
      for (const other of modes.children) other.setAttribute("aria-pressed", String(other === b));
      update();
    };
    return b;
  }));

  const form = h("form", {},
    modes,
    note,
    people.length
      ? h("ul", { class: "people" }, people.map((u, i) => h("li", {}, h("label", { class: "person" }, personRow(u, h("span", { class: "check" }, boxes[i]))))))
      : h("p", { class: "dim" }, "Nobody else has an account yet. Admins can make invite codes on the admin page."),
    groupField,
    h("div", { class: "actions" }, start),
  );
  const dialog = openWindow({ title: "New chat", body: form });
  form.onsubmit = async (e) => {
    e.preventDefault();
    start.disabled = true;
    try {
      const users = boxes.filter((b) => b.checked).map((b) => b.value);
      const body = server ? { kind: "server", users, name: groupName.value } : { users, name: users.length > 1 ? groupName.value : "" };
      const conv = await api("/api/conversations", { method: "POST", body });
      state.conversations.set(conv.id, conv);
      emit("conversations");
      dialog.close();
      onOpen(conv.id);
    } catch (err) {
      toast(err.message, true);
      start.disabled = false;
    }
  };
}

export function details(conv, { onCall }) {
  const partner = partnerOf(conv);
  if (partner) {
    const online = state.online.has(partner.id);
    openWindow({
      title: "Chat details",
      body: [
        h("div", { class: "history-start" },
          avatar(partner, 96, { online }),
          h("strong", {}, partner.displayName),
          h("span", {}, `@${partner.name} · ${online ? "Online" : agoText(partner.lastSeen)}`),
        ),
        h("div", { class: "actions" },
          h("button", { class: "btn plain", type: "button", onclick: () => onCall(conv, false) }, icon("phone", "mid"), "Call"),
          h("button", { class: "btn plain", type: "button", onclick: () => onCall(conv, true) }, icon("video", "mid"), "Video"),
          h("button", { class: "btn plain", type: "button", onclick: () => themePicker(conv) }, icon("palette", "mid"), "Theme"),
        ),
      ],
    });
    return;
  }

  const name = h("input", { maxlength: "60", value: conv.name, placeholder: others(conv).map(nameOf).join(", ") });
  name.onchange = () => api(`/api/conversations/${conv.id}`, { method: "PATCH", body: { name: name.value } }).catch((err) => toast(err.message, true));
  const mineToManage = isMe(conv.createdBy);

  const members = conv.members.map((m) => userOf(m.id) ?? (isMe(m.id) ? state.me : null)).filter(Boolean);
  const list = h("ul", { class: "people" }, members.map((u) => h("li", {}, h("div", { class: "person" }, personRow(u,
    mineToManage && !isMe(u.id)
      ? h("button", { class: "btn plain", type: "button", onclick: async () => {
        if (!(await confirmBox(`Remove ${u.displayName} from the group?`, { ok: "Remove", danger: true }))) return;
        await api(`/api/conversations/${conv.id}/members/${u.id}`, { method: "DELETE" }).catch((err) => toast(err.message, true));
        dialog.close();
      } }, "Remove")
      : isMe(u.id) ? h("small", { class: "dim" }, "You") : null,
  )))));

  const outside = [...state.users.values()].filter((u) => !conv.members.some((m) => m.id === u.id));
  const addBoxes = outside.map((u) => h("input", { type: "checkbox", value: u.name }));
  const addForm = outside.length ? h("form", {},
    h("h3", { class: "section-title" }, "Add people"),
    h("ul", { class: "people" }, outside.map((u, i) => h("li", {}, h("label", { class: "person" }, personRow(u, h("span", { class: "check" }, addBoxes[i])))))),
    h("div", { class: "actions" }, h("button", { class: "btn plain", type: "submit" }, "Add")),
  ) : null;
  if (addForm) {
    addForm.onsubmit = async (e) => {
      e.preventDefault();
      const users = addBoxes.filter((b) => b.checked).map((b) => b.value);
      if (!users.length) return;
      await api(`/api/conversations/${conv.id}/members`, { method: "POST", body: { users } }).catch((err) => toast(err.message, true));
      dialog.close();
    };
  }

  // The picture, the invite link, and (for whoever made it) deleting it.
  const word = conv.kind === "server" ? "server" : "group";
  const picture = h("span", {}, chatAvatar(conv, null, 96));
  const pictureInput = h("input", { type: "file", accept: "image/*", hidden: true });
  pictureInput.onchange = async () => {
    const file = pictureInput.files[0];
    pictureInput.value = "";
    if (!file) return;
    try {
      const square = file.type === "image/gif" && file.size <= 2_000_000 ? file : await squareImage(file, 256);
      await upload(square, { purpose: "icon", name: file.type === "image/gif" ? "icon.gif" : "icon.jpg", query: `&c=${conv.id}` }).done;
      dialog.close();
    } catch (err) {
      toast(err.message, true);
    }
  };
  const link = (code) => `${location.origin}/#/join/${code}`;
  const inviteBox = h("div", { class: "invite-box" });
  const drawInvite = (code) => {
    inviteBox.replaceChildren(
      code ? h("div", { class: "secret" }, link(code)) : h("p", { class: "dim" }, "No invite link yet."),
      h("div", { class: "actions" },
        code ? h("button", { class: "btn plain", type: "button", onclick: () => navigator.clipboard.writeText(link(code)).then(() => toast("Link copied")) }, "Copy link") : null,
        !code || mineToManage ? h("button", { class: "btn plain", type: "button", onclick: async () => {
          try {
            drawInvite((await api(`/api/conversations/${conv.id}/invite`, { method: "POST", body: {} })).invite);
          } catch (err) {
            toast(err.message, true);
          }
        } }, code ? "Make a new link" : "Make a link") : null,
      ),
    );
  };
  drawInvite(conv.invite);

  const dialog = openWindow({
    title: conv.kind === "server" ? "Server" : "Group details",
    body: [
      h("div", { class: "profile-row" }, picture, h("div", { class: "actions" },
        h("button", { class: "btn plain", type: "button", onclick: () => pictureInput.click() }, "Change picture"), pictureInput)),
      h("label", { class: "field" }, h("span", {}, conv.kind === "server" ? "Server name" : "Group name"), name),
      h("h3", { class: "section-title" }, "Invite link"),
      h("p", { class: "dim" }, `Anyone with an account who opens it joins the ${word}.${mineToManage ? " Making a new link stops the old one working." : ""}`),
      inviteBox,
      h("h3", { class: "section-title" }, `${members.length} people`),
      list,
      addForm,
      h("div", { class: "actions" },
        h("button", { class: "btn plain", type: "button", onclick: () => themePicker(conv) }, icon("palette", "mid"), "Theme"),
        h("button", { class: "btn danger", type: "button", onclick: async () => {
          if (!(await confirmBox("You'll stop getting its messages. Someone in it can add you back.", { title: `Leave ${word}?`, ok: "Leave", danger: true }))) return;
          await api(`/api/conversations/${conv.id}/members/${state.me.id}`, { method: "DELETE" }).catch((err) => toast(err.message, true));
          dialog.close();
        } }, `Leave ${word}`),
        mineToManage ? h("button", { class: "btn danger", type: "button", onclick: async () => {
          if (!(await confirmBox(`This deletes the ${word} and everything in it, for everyone. It can't be undone.`, { title: `Delete ${titleOf(conv)}?`, ok: "Delete", danger: true }))) return;
          await api(`/api/conversations/${conv.id}`, { method: "DELETE" }).catch((err) => toast(err.message, true));
          dialog.close();
        } }, `Delete ${word}`) : null,
      ),
    ],
  });
}

// Opening an invite link: what it's for, and a button to join.
export async function joinDialog(code, onOpen) {
  let info;
  try {
    info = await api(`/api/join/${code}`);
  } catch (err) {
    return toast(err.message, true);
  }
  if (info.joined) return onOpen(info.id);
  const join = h("button", { class: "btn", type: "button" }, `Join the ${info.kind === "server" ? "server" : "group"}`);
  const dialog = openWindow({
    title: "You're invited",
    body: [
      h("div", { class: "history-start" },
        avatar({ name: `group-${info.id}`, avatar: info.icon }, 96),
        h("strong", {}, info.name || "A group"),
        h("span", {}, `${info.members} ${info.members === 1 ? "person" : "people"} in it`),
      ),
      h("div", { class: "actions" }, h("button", { class: "btn plain", type: "button", onclick: () => dialog.close() }, "Not now"), join),
    ],
  });
  join.onclick = async () => {
    join.disabled = true;
    try {
      const conv = await api(`/api/join/${code}`, { method: "POST", body: {} });
      state.conversations.set(conv.id, conv);
      emit("conversations");
      dialog.close();
      onOpen(conv.id);
    } catch (err) {
      toast(err.message, true);
      join.disabled = false;
    }
  };
}

export function lightbox(attachment) {
  const close = h("button", { class: "icon-btn", type: "button", "aria-label": "Close" }, icon("close"));
  const dialog = h("dialog", { class: "lightbox" }, h("div", { class: "lightbox-inner" },
    h("div", { class: "lightbox-bar" },
      h("a", { class: "icon-btn", href: attachment.url, target: "_blank", rel: "noopener noreferrer", "aria-label": "Open full size" }, icon("download")),
      close,
    ),
    h("div", { class: "lightbox-img" }, h("img", { src: attachment.url, alt: attachment.name })),
  ));
  close.onclick = () => dialog.close();
  dialog.addEventListener("click", (e) => {
    if (e.target.closest(".lightbox-img") && e.target.tagName !== "IMG") dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
