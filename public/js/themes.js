// Kept in step with THEMES in server.js and the palettes in style.css.

import { local } from "/js/dom.js";
import { setWeather } from "/js/weather.js";

export const THEMES = [
  { id: "farmhouse", name: "Farmhouse", note: "Farmhouse floorboards and parchment" },
  { id: "spring", name: "Spring", note: "Blossom on new grass" },
  { id: "summer", name: "Summer", note: "Warm sand by the sea" },
  { id: "autumn", name: "Autumn", note: "Falling leaves" },
  { id: "winter", name: "Winter", note: "Snow at night, warm lights" },
  { id: "rainy", name: "Rainy", note: "Rain on the window" },
  { id: "forest", name: "Forest", note: "Moss and drifting leaves" },
  { id: "ocean", name: "Ocean", note: "Deep water and bubbles" },
  { id: "campfire", name: "Campfire", note: "Embers in the dark" },
  { id: "cafe", name: "Café", note: "Checked tablecloth and latte" },
  { id: "light", name: "Light", note: "Plain and bright" },
  { id: "dark", name: "Dark", note: "Plain and dim" },
];

export const themeName = (id) => THEMES.find((t) => t.id === id)?.name ?? id;

// Remembered on this device too, so the login page and the first paint
// already look right.
export function applyTheme(id) {
  const theme = THEMES.some((t) => t.id === id) ? id : "farmhouse";
  document.documentElement.dataset.theme = theme;
  local.set("theme", theme);
  setWeather(theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
}

export function applyFont(font) {
  if (font === "smooth") document.documentElement.dataset.font = "smooth";
  else delete document.documentElement.dataset.font;
  local.set("font", font);
}
