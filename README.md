# cozy pixel chat

A small invite-only chat app in a pixel-art style. DMs, groups and servers,
with themes everyone in the chat shares.

![A one-to-one chat in the Farmhouse theme](docs/screenshots/chat.png)

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/themes.png" alt="Theme picker"></td>
    <td width="50%"><img src="docs/screenshots/server.png" alt="A server in the Campfire theme"></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/profile.png" alt="Profile card"></td>
    <td width="50%" align="center"><img src="docs/screenshots/phone.png" alt="On a phone" width="260"></td>
  </tr>
</table>

## Features

- Live messages: replies, reactions, edits, unsend, mentions, typing, read receipts, pins, search
- Photos, video, files, voice notes and stickers
- Voice/video calls for up to 6, with screen sharing
- Watch YouTube together with `/watch <link>`
- 12 themes with little weather effects
- Profiles with avatars, banners and badges
- Invite codes, admin page, roles

## Quick start

```sh
git clone https://github.com/SnakeLuck360GT/cozy-pixel-chat.git
cd cozy-pixel-chat
docker compose up -d
docker compose exec app chat-admin add-user yourname --owner
```

Open <http://localhost> and log in with the printed password.

**On a real server:** point two subdomains at it (app + files), copy
`.env.example` to `.env`, fill in `PUBLIC_URL` and `CONTENT_URL`, then
`docker compose up -d`. Caddy handles HTTPS. For calls over mobile data, fill
in the TURN settings, open UDP/TCP 3478 and UDP 49160-49200, and run
`docker compose --profile calls up -d`.

No Docker? `deploy/setup.sh` sets it all up on Ubuntu (Node, Caddy, coturn, systemd).

## Development

Needs Node 22.13+.

```sh
npm install
node manage.js add-user me --owner
PUBLIC_URL=http://localhost:8080 CONTENT_URL=http://localhost:8081 npm start
node dev/proxy.js   # then open http://localhost:8080
```

## Stack

- Node.js with plain `node:http` and `ws`, SQLite via `node:sqlite`
- Vanilla JS frontend, no framework or build step
- WebRTC calls, coturn as the relay
- Uploads served from a separate cookie-less origin with signed, expiring links

## License

MIT. Fonts (Silkscreen, Pixelify Sans) are OFL, see `public/vendor/`.
