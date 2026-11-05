<p align="center"><i>a tiny, cozy, invite-only chat app for you and your favourite people 🌼</i></p>

<p align="center">
  <img src="https://img.shields.io/badge/node.js-22.13+-a8d672?style=flat-square&logo=nodedotjs&logoColor=fff8ec&labelColor=7c4a26" alt="node.js 22.13+">
  <img src="https://img.shields.io/badge/sqlite-built--in-f4b860?style=flat-square&logo=sqlite&logoColor=fff8ec&labelColor=7c4a26" alt="sqlite">
  <img src="https://img.shields.io/badge/calls-webrtc-f39bb0?style=flat-square&logo=webrtc&logoColor=fff8ec&labelColor=7c4a26" alt="webrtc">
  <img src="https://img.shields.io/badge/frontend-vanilla%20js-ffe27a?style=flat-square&logo=javascript&logoColor=fff8ec&labelColor=7c4a26" alt="vanilla js">
  <img src="https://img.shields.io/badge/build%20step-none%20✿-c9b6e8?style=flat-square&labelColor=7c4a26" alt="no build step">
  <img src="https://img.shields.io/badge/docker-compose-8ec5e8?style=flat-square&logo=docker&logoColor=fff8ec&labelColor=7c4a26" alt="docker compose">
  <img src="https://img.shields.io/badge/license-MIT-e8d5b0?style=flat-square&labelColor=7c4a26" alt="MIT license">
</p>

![a chat in the farmhouse theme](docs/screenshots/chat.png)

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/themes.png" alt="the theme picker"></td>
    <td width="50%"><img src="docs/screenshots/server.png" alt="a server in the campfire theme"></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/profile.png" alt="a profile card"></td>
    <td width="50%" align="center"><img src="docs/screenshots/phone.png" alt="on a phone" width="260"></td>
  </tr>
</table>

## 🌱 what's inside

- messages that pop up live, with replies, reactions, edits, unsend, @mentions, typing dots, "seen", pins and search
- photos, videos, files, voice notes and little hand-drawn pixel stickers
- calls with up to 6 friends, with screen sharing ☎️
- watch youtube together with `/watch <link>` 🍿
- 12 themes (farmhouse, spring, rainy, campfire, café…), with tiny weather drifting by ☔
- profiles with avatars, banners and badges
- invite codes only, so it stays just your people 💛

## 🍄 grow your own

```sh
git clone https://github.com/SnakeLuck360GT/cozy-pixel-chat.git
cd cozy-pixel-chat
docker compose up -d
docker compose exec app chat-admin add-user yourname --owner
```

open <http://localhost>, log in with the password it printed, and make yourself a cup of tea ☕

**on a real server:** point two subdomains at it (one for the app, one for files),
copy `.env.example` to `.env`, fill in `PUBLIC_URL` and `CONTENT_URL`, then
`docker compose up -d`. caddy sorts out https for you. for calls over mobile
data, fill in the TURN bits, open UDP/TCP 3478 and UDP 49160-49200, and run
`docker compose --profile calls up -d`.

no docker? `deploy/setup.sh` sets it all up on ubuntu (node, caddy, coturn, systemd).

## 🐝 tinkering

needs node 22.13 or newer.

```sh
npm install
node manage.js add-user me --owner
PUBLIC_URL=http://localhost:8080 CONTENT_URL=http://localhost:8081 npm start
node dev/proxy.js   # then open http://localhost:8080
```

## 📖 how it works

curious about the insides? it's all written up in [docs/how-it-works.md](docs/how-it-works.md) 🌿

## 🌻 license

MIT, so share it around 💛 the fonts (silkscreen, pixelify sans) are OFL, see `public/vendor/`.
