## Overview

```mermaid
flowchart LR
  B[Browser] -->|pages, /api, /upload, /ws| C1[Caddy<br>chat.example.com]
  B -->|signed file links| C2[Caddy<br>chat-files.example.com]
  C1 --> N[Node server]
  C2 --> N
  N --- DB[(SQLite)]
  N --- F[(files/)]
  B <-.->|WebRTC| B2[Other browsers]
  B <-.->|relay if needed| T[coturn]
```

- One Node process: API, uploads, WebSocket hub, attachment server
- Caddy: HTTPS, static pages, reverse proxy
- No framework on either side: `node:http` + plain ES modules

## Attachments on a second origin

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as chat.example.com
  participant F as chat-files.example.com
  B->>A: GET /api/conversations/1/messages (cookie)
  A-->>B: messages + /key?e=expiry&s=hmac
  B->>F: GET /key?e=...&s=... (no cookie)
  F->>F: check HMAC + expiry
  F-->>B: file (inline only if image/video/audio)
```

- Uploaded files can never run as the app or read the session cookie
- Links are HMAC-signed and expire after ~24h (rounded to the hour for caching)
- File type is sniffed from the first bytes, not the name or browser's claim
- Anything that isn't plain image/video/audio is forced to download

## Messages

```mermaid
sequenceDiagram
  participant S as Sender
  participant N as Node
  participant O as Others in chat
  S->>S: show message instantly (with nonce)
  S->>N: POST /api/conversations/:id/messages {text, nonce}
  N->>N: insert into SQLite
  N-->>S: WS {t: "message", message, nonce}
  N-->>O: WS {t: "message", message, nonce}
  S->>S: swap optimistic copy for real one
```

- One WebSocket per tab, authenticated by the session cookie
- Origin is checked on upgrade (other sites can open sockets with your cookies)
- Pushes: messages, edits, reactions, typing, read markers, presence, theme changes

## Calls

```mermaid
sequenceDiagram
  participant A as Alice
  participant N as Node
  participant B as Bob
  A->>N: call-join
  N-->>B: call-ring (45s)
  B->>N: call-join
  N-->>B: call-joined {peers: [Alice]}
  N-->>A: call-peer-joined {Bob}
  A->>N: call-signal (offer / ICE)
  N-->>B: call-signal
  B->>N: call-signal (answer / ICE)
  N-->>A: call-signal
  A<<->>B: audio + video (direct or via coturn)
```

- One call per chat, up to 6 people, kept in memory (`lib/calls.js`)
- Full mesh: one `RTCPeerConnection` per pair, "perfect negotiation" for mid-call changes
- Server only relays signalling, media never touches it
- Ends when everyone leaves, or after someone is alone for 3 minutes
- TURN logins are short-lived HMACs of a secret shared with coturn

## Watch together

- `/watch <link>` stores video, position and play state per chat (in memory)
- Changes are broadcast over the WebSocket
- Clients use the server's clock to agree on the current position
- youtube-nocookie.com embed, controlled with `postMessage` (no YouTube JS in the app)

## Data

```mermaid
erDiagram
  users ||--o{ sessions : has
  users ||--o{ members : joins
  conversations ||--o{ members : has
  conversations ||--o{ messages : contains
  users ||--o{ messages : sends
  messages ||--o{ attachments : has
  messages ||--o{ reactions : has
  users ||--o{ reactions : gives
  attachments ||--o| stickers : "used by"
```

- SQLite via `node:sqlite` (WAL mode), nothing to compile
- Conversations are `dm`, `group` or `server`
- Attachments are uploaded first and linked to a message on send
- Hourly sweep: unsent uploads older than a day, expired sessions, old invites

## Security

- Passwords: scrypt
- Session tokens and invite codes stored only as hashes
- `__Host-` cookie over HTTPS (files subdomain can't set or overwrite it)
- Login rate limiting per IP; unknown usernames take as long as wrong passwords
- API writes require JSON and a matching Origin
- Strict CSP, `frame-ancestors 'none'`
- Photos are resized client-side; redrawing JPEGs strips EXIF/GPS

## Frontend

- Plain ES modules, no bundler
- Tiny `h()` helper for building DOM
- Icons are 12×12 pixel grids in code, stickers are drawn from strings
- Themes are CSS variables + a small SVG tile
