import { api } from "/js/api.js";
import { $ } from "/js/dom.js";
import { talkScene } from "/js/scene.js";
import { setWeather } from "/js/weather.js";

$("art").append(talkScene());
setWeather(document.documentElement.dataset.theme);

const code = new URLSearchParams(location.search).get("code");
if (code) $("code").value = code;

$("signup").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("status").textContent = "";
  const submit = e.submitter;
  submit.disabled = true;
  try {
    await api("/api/signup", {
      method: "POST",
      body: { code: $("code").value, username: $("username").value, password: $("password").value, acceptTerms: $("terms").checked },
    });
    location.href = "/";
  } catch (err) {
    $("status").textContent = err.message;
    submit.disabled = false;
    shake();
  }
});

(code ? $("username") : $("code")).focus();

// A wrong answer gives the window a little shake.
function shake() {
  const box = document.querySelector(".auth-box .window");
  box.classList.remove("shake");
  void box.offsetWidth;
  box.classList.add("shake");
}
