<p align="center"><i>stardew valley inspired cozy chat</i></p>

<p align="center">
  <img src="https://img.shields.io/badge/node.js-22.13+-a8d672?style=flat-square&logo=nodedotjs&logoColor=fff8ec&labelColor=7c4a26" alt="node.js 22.13+">
  <img src="https://img.shields.io/badge/sqlite-built--in-f4b860?style=flat-square&logo=sqlite&logoColor=fff8ec&labelColor=7c4a26" alt="sqlite">
  <img src="https://img.shields.io/badge/calls-webrtc-f39bb0?style=flat-square&logo=webrtc&logoColor=fff8ec&labelColor=7c4a26" alt="webrtc">
  <img src="https://img.shields.io/badge/frontend-vanilla%20js-ffe27a?style=flat-square&logo=javascript&logoColor=fff8ec&labelColor=7c4a26" alt="vanilla js">
  <img src="https://img.shields.io/badge/build%20step-none-c9b6e8?style=flat-square&labelColor=7c4a26" alt="no build step">
  <img src="https://img.shields.io/badge/docker-compose-8ec5e8?style=flat-square&logo=docker&logoColor=fff8ec&labelColor=7c4a26" alt="docker compose">
  <img src="https://img.shields.io/badge/license-MIT-e8d5b0?style=flat-square&labelColor=7c4a26" alt="MIT license">
</p>

![Chat in the Farmhouse theme](docs/screenshots/chat.png)

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/themes.png" alt="Theme picker"></td>
    <td width="50%"><img src="docs/screenshots/server.png" alt="Server in the Campfire theme"></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/profile.png" alt="Profile card"></td>
    <td width="50%" align="center"><img src="docs/screenshots/phone.png" alt="Mobile view" width="260"></td>
  </tr>
</table>

## Features

- Real-time messaging with replies, reactions, edits, unsend, @mentions, typing indicators, read receipts, pins and search
- Photos, videos, files, voice notes and pixel-art stickers
- Voice and video calls for up to 6 people, with screen sharing
- Watch YouTube together with `/watch <link>`
- 12 themes with animated weather effects
- Profiles with avatars, banners and badges
- Invite-only sign-up, with an admin page and roles

## Getting started

```sh
git clone https://github.com/SnakeLuck360GT/cozy-pixel-chat.git
cd cozy-pixel-chat
docker compose up -d
docker compose exec app chat-admin add-user yourname --owner
```

Open <http://localhost> and log in with the printed password.

### Production

1. Point two subdomains at the server (one for the app, one for files).
2. Copy `.env.example` to `.env` and set `PUBLIC_URL` and `CONTENT_URL`.
3. Run `docker compose up -d`. Caddy handles HTTPS.

For calls over mobile networks, set the TURN values in `.env`, open UDP/TCP 3478
and UDP 49160-49200, and run `docker compose --profile calls up -d`.

Without Docker, `deploy/setup.sh` installs everything on Ubuntu (Node, Caddy, coturn, systemd).

## Development

Requires Node 22.13+.

```sh
npm install
node manage.js add-user me --owner
PUBLIC_URL=http://localhost:8080 CONTENT_URL=http://localhost:8081 npm start
node dev/proxy.js   # then open http://localhost:8080
```

## How it works

See [docs/how-it-works.md](docs/how-it-works.md).

## License

[MIT](LICENSE). Bundled fonts (Silkscreen, Pixelify Sans) are under the SIL Open Font License.
