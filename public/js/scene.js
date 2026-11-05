// The little looping chat on the login page and the empty home screen: one
// bubble pops up, then a reply starts typing. The motion is all in
// style.css (.talk), so reduced-motion settings simply show both bubbles.

import { h } from "/js/dom.js";
import { art } from "/js/icons.js";

export function talkScene() {
  return h("div", { class: "talk", "aria-hidden": "true" },
    h("div", { class: "talk-left" }, art("talkLeft")),
    h("div", { class: "talk-right" }, art("talkRight"), h("span", { class: "talk-dots" }, h("i"), h("i"), h("i"))),
  );
}
