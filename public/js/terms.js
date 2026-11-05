// Logged-in people who haven't accepted the current terms get an "I agree"
// box at the top; sending stays blocked until they do.

import { api } from "/js/api.js";
import { $ } from "/js/dom.js";

const res = await fetch("/api/me");
const me = res.ok ? await res.json() : null;

if (me?.needsTerms) {
  $("accept").hidden = false;
  $("accept").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/me/terms", { method: "POST", body: { accept: $("agree").checked } });
      const next = new URLSearchParams(location.search).get("next");
      location.href = next?.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch (err) {
      $("accept-status").textContent = err.message;
    }
  });
}
