// Stickers: a pack of pixel pictures and word bubbles drawn here (so there
// are no image files), plus ones people upload, which everyone can use.

import { api, upload } from "/js/api.js";
import { h, toast } from "/js/dom.js";
import { icon } from "/js/icons.js";
import { isMe, state } from "/js/store.js";
import { closePopover, popover } from "/js/ui.js";

const OUTLINE = "#3a2414";

// Each letter is a colour; "." is empty. Sizes vary, they're scaled to fit.
const PICTURES = {
  heart: {
    colours: { o: OUTLINE, r: "#e8475f", w: "#ffd1d9" },
    rows: [
      "..ooo....ooo..",
      ".orrro..orrro.",
      "orwwrroorrrrro",
      "orwrrrrrrrrrro",
      "orrrrrrrrrrrro",
      ".orrrrrrrrrro.",
      "..orrrrrrrro..",
      "...orrrrrro...",
      "....orrrro....",
      ".....orro.....",
      "......oo......",
    ],
  },
  cat: {
    colours: { o: OUTLINE, y: "#f4b860", k: OUTLINE, p: "#f08a9a" },
    rows: [
      ".oo..........oo.",
      ".oyo........oyo.",
      ".oyyo......oyyo.",
      ".oyyyooooooyyyo.",
      "oyyyyyyyyyyyyyyo",
      "oyyyyyyyyyyyyyyo",
      "oyyykkyyyykkyyyo",
      "oyyykkyyyykkyyyo",
      "oyyyyyyppyyyyyyo",
      "oyyyyykyykyyyyyo",
      ".oyyyyykkyyyyyo.",
      "..oyyyyyyyyyyo..",
      "...oooooooooo...",
    ],
  },
  frog: {
    colours: { o: OUTLINE, g: "#6cbf4e", w: "#fff8ec", k: OUTLINE, p: "#f39bb0" },
    rows: [
      "..ooo......ooo..",
      ".owkwo....owkwo.",
      ".owwwoooooowwwo.",
      "oggggggggggggggo",
      "oggggggggggggggo",
      "ogppggggggggppgo",
      "ogggkggggggkgggo",
      "oggggkkkkkkggggo",
      ".oggggggggggggo.",
      "..oooooooooooo..",
    ],
  },
  dog: {
    colours: { o: OUTLINE, b: "#8a5a3a", t: "#e8c08a", k: OUTLINE, p: "#f08a9a" },
    rows: [
      ".ooo........ooo.",
      "obbbo......obbbo",
      "obbboooooooobbbo",
      "obbottttttttobbo",
      "obbottttttttobbo",
      ".oottkttttkttoo.",
      "..otttttttttto..",
      "..otttkkkkttto..",
      "..ottttkktttto..",
      "...otttppttto...",
      "....oooooooo....",
    ],
  },
  coffee: {
    colours: { o: OUTLINE, s: "#c9b8a8", c: "#6b3d1b", m: "#e8475f", w: "#ffd1d9" },
    rows: [
      "....s..s..s.....",
      ".....s..s..s....",
      "....s..s..s.....",
      "................",
      "..oooooooooooo..",
      "..occcccccccco..",
      "..ommmmmmmmmmooo",
      "..omwmmmmmmmmo.o",
      "..omwmmmmmmmmo.o",
      "..ommmmmmmmmmooo",
      "..ommmmmmmmmmo..",
      "...ommmmmmmmo...",
      "....oooooooo....",
      ".oooooooooooooo.",
    ],
  },
  ramen: {
    colours: { o: OUTLINE, s: "#d8c8b8", b: "#e9a35b", n: "#f6d77a", w: "#fff8ec", y: "#ffc23a", g: "#5aa83a", r: "#c83a3a" },
    rows: [
      "...s....s....s..",
      "....s....s....s.",
      "................",
      "oooooooooooooooo",
      "obbbbbbbbbbbbbbo",
      "obnwwywnnnngnnbo",
      "orrrrrrrrrrrrrro",
      ".orrrrrrrrrrrro.",
      ".orrwrrwrrwrrro.",
      "..orrrrrrrrrro..",
      "...oooooooooo...",
    ],
  },
  cake: {
    colours: { o: OUTLINE, r: "#e8475f", w: "#fff8ec", p: "#f39bb0", c: "#f2c879" },
    rows: [
      "......rr......",
      "......rr......",
      "..oooooooooo..",
      ".owwwwwwwwwwo.",
      ".owwpwwwpwwwo.",
      ".occcccccccco.",
      ".oppppppppppo.",
      ".occcccccccco.",
      ".occcccccccco.",
      "..oooooooooo..",
    ],
  },
  strawberry: {
    colours: { o: OUTLINE, g: "#5aa83a", r: "#e8475f", y: "#ffe08a" },
    rows: [
      ".....gg.....",
      "...gggggg...",
      "..oggggggo..",
      ".orrrrrrrro.",
      "orryrrrryrro",
      "orrrrrrrrrro",
      "orrrryrrrrro",
      ".orrrrrryro.",
      ".oryrrrrrro.",
      "..orrrryro..",
      "...orrrro...",
      "....orro....",
      ".....oo.....",
    ],
  },
  star: {
    colours: { o: OUTLINE, y: "#ffd23f" },
    rows: [
      "......o......",
      ".....oyo.....",
      "....oyyyo....",
      "ooooyyyyyoooo",
      "oyyyyyyyyyyyo",
      ".oyyyyyyyyyo.",
      "..oyyyyyyyo..",
      "..oyyyyyyyo..",
      ".oyyyyoyyyyo.",
      ".oyyyo.oyyyo.",
      "oyyo.....oyyo",
      "ooo.......ooo",
    ],
  },
  sunflower: {
    colours: { y: "#ffd23f", b: "#8a5a2a", g: "#5aa83a" },
    rows: [
      "....yy.yy....",
      "...yyyyyyy...",
      ".yyyybbbyyyy.",
      "yyyybbbbbyyyy",
      ".yybbbbbbbyy.",
      "yyybbbbbbbyyy",
      ".yybbbbbbbyy.",
      "yyyybbbbbyyyy",
      ".yyyybbbyyyy.",
      "...yyyyyyy...",
      "....yy.yy....",
      "......g......",
      ".....ggg.....",
    ],
  },
  pumpkin: {
    colours: { o: OUTLINE, g: "#5aa83a", n: "#e8843a", d: "#c8622a" },
    rows: [
      "......gg......",
      "......g.......",
      "...oooooooo...",
      ".onndnndnndno.",
      "onnndnndnndnno",
      "onnndnndnndnno",
      "onnndnndnndnno",
      ".onndnndnndno.",
      "..oooooooooo..",
    ],
  },
  controller: {
    colours: { o: OUTLINE, p: "#7a8bd8", k: OUTLINE, y: "#ffd23f", r: "#e8475f" },
    rows: [
      "..oooooooooooo..",
      ".oppppppppppppo.",
      "oppkppppppppyppo",
      "opkkkpppppprpypo",
      "oppkpppppppprppo",
      "oppppppppppppppo",
      "opppppoooopppppo",
      ".opppo....opppo.",
      "..ooo......ooo..",
    ],
  },
};

// Pixel speech bubbles with a word in the pixel font.
const WORDS = {
  hi: ["hi!", "#ffe08a"],
  gm: ["gm", "#ffd1a8"],
  gn: ["gn", "#c9d4ff"],
  omw: ["omw", "#c8f0c0"],
  lol: ["lol", "#ffd1d9"],
  ok: ["ok!", "#e6e0d4"],
  brb: ["brb", "#d8f0f0"],
  ty: ["ty!", "#ffe0f0"],
  yay: ["yay", "#fff0a8"],
  hehe: ["hehe", "#f0d8ff"],
  wow: ["wow", "#ffe4c4"],
  nooo: ["nooo", "#dde4ee"],
};

export const PACK = [...Object.keys(PICTURES), ...Object.keys(WORDS).map((w) => `word-${w}`)];

const NS = "http://www.w3.org/2000/svg";

function svgOf(width, height, label) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "sticker-art");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  return svg;
}

const picture = (id) => drawPixels(PICTURES[id], `${id} sticker`);

// Any pixel picture: rows of letters, each letter a colour.
export function drawPixels({ colours, rows }, label) {
  const svg = svgOf(rows[0].length, rows.length, label);
  for (const [char, colour] of Object.entries(colours)) {
    let d = "";
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== char) continue;
        let end = x;
        while (row[end + 1] === char) end++;
        d += `M${x} ${y}h${end - x + 1}v1h-${end - x + 1}z`;
        x = end;
      }
    });
    if (!d) continue;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", colour);
    svg.append(path);
  }
  return svg;
}

function word(id) {
  const [text, colour] = WORDS[id];
  const width = Math.max(28, text.length * 8 + 12);
  const svg = svgOf(width + 2, 24, `"${text}" sticker`);
  // A notched bubble with a little tail, in pixel steps.
  const bubble = document.createElementNS(NS, "path");
  const W = width;
  bubble.setAttribute("d", `M2 1H${W}V2H${W + 1}V17H${W}V18H10V19H9V20H8V21H7V18H2V17H1V2H2Z`);
  bubble.setAttribute("fill", colour);
  bubble.setAttribute("stroke", OUTLINE);
  bubble.setAttribute("stroke-width", "1");
  bubble.setAttribute("shape-rendering", "crispEdges");
  const label = document.createElementNS(NS, "text");
  label.setAttribute("x", String((width + 2) / 2));
  label.setAttribute("y", "13");
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("class", "sticker-word");
  label.textContent = text;
  svg.append(bubble, label);
  return svg;
}

// A sticker by id: a pack name, "word-…", or an uploaded one with its picture link.
export function sticker(id, url) {
  if (id.startsWith("custom:")) {
    if (!url) return h("span", { class: "sticker-gone" }, "Sticker removed");
    return h("img", { class: "sticker-img", src: url, alt: "Sticker", loading: "lazy", decoding: "async" });
  }
  if (PICTURES[id]) return picture(id);
  if (id.startsWith("word-") && WORDS[id.slice(5)]) return word(id.slice(5));
  return h("span", { class: "sticker-gone" }, "Sticker");
}

// Uploaded stickers, loaded once and kept up to date as people add them.
let custom = null;

async function loadCustom() {
  custom ??= await api("/api/stickers").catch(() => []);
  return custom;
}

// Big pictures are shrunk to 320px; GIFs go up as they are so they keep moving.
async function prepareSticker(file) {
  if (file.type === "image/gif") return { blob: file, name: file.name };
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That picture couldn't be opened. Try a PNG, JPEG or GIF.");
  });
  const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
  const canvas = h("canvas", { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return { blob, name: "sticker.png" };
}

export async function stickerPicker(anchor, onPick) {
  const items = await loadCustom();
  const pick = (id, url) => () => {
    closePopover();
    onPick(id, url);
  };
  const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
  const yours = h("div", { class: "sticker-grid" });
  const drawYours = () => yours.replaceChildren(
    h("button", { class: "sticker-btn add", type: "button", title: "Add your own sticker", onclick: () => fileInput.click() }, icon("plus")),
    ...custom.map((s) => {
      const canRemove = isMe(s.user) || state.me.admin;
      return h("span", { class: "sticker-cell" },
        h("button", { class: "sticker-btn", type: "button", onclick: pick(s.id, s.url) }, sticker(s.id, s.url)),
        canRemove ? h("button", { class: "sticker-remove", type: "button", "aria-label": "Remove this sticker", title: "Remove", onclick: async () => {
          try {
            await api(`/api/stickers/${s.id}`, { method: "DELETE" });
            custom = custom.filter((x) => x !== s);
            drawYours();
          } catch (err) {
            toast(err.message, true);
          }
        } }, icon("close", "small")) : null,
      );
    }),
  );
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const { blob, name } = await prepareSticker(file);
      if (blob.size > 2_000_000) throw new Error("Stickers can be at most 2 MB");
      const added = await upload(blob, { purpose: "sticker", name }).done;
      custom.unshift(added);
      drawYours();
    } catch (err) {
      toast(err.message, true);
    }
  };
  drawYours();
  popover(anchor, h("div", { class: "sticker-picker" },
    h("h3", {}, "Pixel pack"),
    h("div", { class: "sticker-grid" }, PACK.map((id) => h("button", { class: "sticker-btn", type: "button", onclick: pick(id) }, sticker(id)))),
    h("h3", {}, "Uploaded"),
    yours,
    fileInput,
  ));
}
