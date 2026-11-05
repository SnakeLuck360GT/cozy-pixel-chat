// Runs before the page draws, so it opens in the last theme used on this
// device instead of flashing the default one. Kept tiny and non-module.
try {
  var theme = localStorage.getItem("theme");
  if (theme) document.documentElement.dataset.theme = theme;
  if (localStorage.getItem("font") === "smooth") document.documentElement.dataset.font = "smooth";
} catch (e) {}
