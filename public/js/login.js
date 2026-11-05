import { api } from "/js/api.js";
import { $ } from "/js/dom.js";
import { talkScene } from "/js/scene.js";
import { setWeather } from "/js/weather.js";

$("art").append(talkScene());
setWeather(document.documentElement.dataset.theme);

// Only follow same-site paths after logging in.
function nextPage() {
  const next = new URLSearchParams(location.search).get("next");
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
}

// Already logged in? Skip the form.
const me = await fetch("/api/me");
if (me.ok) location.replace(nextPage());

$("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("status").textContent = "";
  const submit = e.submitter;
  submit.disabled = true;
  try {
    await api("/api/login", { method: "POST", body: { username: $("username").value, password: $("password").value } });
    location.href = nextPage();
  } catch (err) {
    $("status").textContent = err.message;
    submit.disabled = false;
    shake();
  }
});

$("username").focus();

// A wrong answer gives the window a little shake.
function shake() {
  const box = document.querySelector(".auth-box .window");
  box.classList.remove("shake");
  void box.offsetWidth;
  box.classList.add("shake");
}
