// Profiles: a banner (a picture or a colour), the picture, name, pronouns,
// a status, badges, a bio and when they joined. Opened by tapping someone's
// picture or name; your own is edited in Settings.

import { avatar } from "/js/avatar.js";
import { h } from "/js/dom.js";
import { icon } from "/js/icons.js";
import { isMe, state, userOf } from "/js/store.js";
import { drawPixels, sticker } from "/js/stickers.js";
import { openWindow } from "/js/ui.js";

// Kept in step with BADGES in server.js. Each borrows a sticker's picture.
export const BADGES = [
  { id: "gamer", art: "controller", name: "Gamer" },
  { id: "cat", art: "cat", name: "Cat person" },
  { id: "dog", art: "dog", name: "Dog person" },
  { id: "coffee", art: "coffee", name: "Runs on coffee" },
  { id: "foodie", art: "ramen", name: "Foodie" },
  { id: "sweet", art: "cake", name: "Sweet tooth" },
  { id: "plants", art: "sunflower", name: "Plant lover" },
  { id: "spooky", art: "pumpkin", name: "Spooky season" },
  { id: "star", art: "star", name: "Star" },
  { id: "frog", art: "frog", name: "Frog fan" },
  { id: "berry", art: "strawberry", name: "Berry sweet" },
  { id: "heart", art: "heart", name: "Big heart" },
];
export const MAX_BADGES = 4;

// Banner colours for people without a banner picture.
export const COLOURS = ["#e8475f", "#f08a3c", "#e2b23a", "#5d9e34", "#3fa7aa", "#3a63a6", "#7a5bb5", "#df6489", "#8a5a3a", "#2b2a28"];

const CROWN = {
  colours: { y: "#ffd23f", r: "#e8475f", b: "#5aa8e8", o: "#c8902a" },
  rows: [
    "y....y....y",
    "yy..yyy..yy",
    "yyy.yyy.yyy",
    "yyyyyyyyyyy",
    "yryyybyyyry",
    "yyyyyyyyyyy",
    "ooooooooooo",
  ],
};

const SHIELD = {
  colours: { o: "#2b3a6a", b: "#5a8ae8", w: "#cfe0ff" },
  rows: [
    "ooooooooo",
    "obbbbbbbo",
    "obwbbbbbo",
    "obwbbbbbo",
    "obbbbbbbo",
    "obbbbbbbo",
    ".obbbbbo.",
    "..obbbo..",
    "...obo...",
    "....o....",
  ],
};
const ROLE_ART = { crown: CROWN, shield: SHIELD };

export function badgeIcon(badge) {
  return h("span", { class: "badge-icon", title: badge.name }, ROLE_ART[badge.art] ? drawPixels(ROLE_ART[badge.art], badge.name) : sticker(badge.art));
}

// Owner and admin come first and can't be picked; then the person's own.
export function badgesOf(user) {
  const list = [];
  if (user.role === "owner") list.push({ id: "owner", art: "crown", name: "Owner" });
  else if (user.role === "admin") list.push({ id: "admin", art: "shield", name: "Admin" });
  for (const id of user.badges ?? []) {
    const badge = BADGES.find((b) => b.id === id);
    if (badge) list.push(badge);
  }
  return list;
}

const joined = (time) => new Date(time).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });

// The card. `actions` are buttons to show at the bottom (message, call…).
export function openProfile(userId, { actions = [] } = {}) {
  const user = isMe(userId) ? { ...userOf(userId), ...state.me } : userOf(userId);
  if (!user) return;
  const online = state.online.has(user.id) || isMe(user.id);
  const banner = h("div", { class: "profile-banner" });
  if (user.banner) banner.append(h("img", { src: user.banner, alt: "" }));
  else if (user.color) banner.style.background = user.color;

  const badges = badgesOf(user);
  openWindow({
    title: isMe(user.id) ? "Your profile" : "Profile",
    className: "profile",
    body: [
      banner,
      h("div", { class: "profile-top" },
        avatar(user, 96, { online }),
        badges.length ? h("div", { class: "profile-badges" }, badges.map(badgeIcon)) : null,
      ),
      h("div", { class: "profile-names" },
        h("strong", {}, user.displayName),
        h("span", {}, `@${user.name}${user.pronouns ? ` · ${user.pronouns}` : ""}`),
      ),
      user.status ? h("p", { class: "profile-status" }, user.status) : null,
      user.bio ? h("div", { class: "profile-section" }, h("h4", {}, "About"), h("p", { class: "profile-bio" }, user.bio)) : null,
      user.created ? h("div", { class: "profile-section" }, h("h4", {}, "Member since"), h("p", {}, joined(user.created))) : null,
      actions.length ? h("div", { class: "actions" }, actions) : null,
    ],
  });
}

export const actionButton = (iconName, label, onclick) => h("button", { class: "btn plain", type: "button", onclick }, icon(iconName, "mid"), label);
