# MTG Table

A self-hosted video table for playing paper Magic remotely: 1080p at about 5 Mbps per player
(SpellTable sends about 960×720 at roughly 1 Mbps), with private invite links.

## How it works

- **LiveKit server** (`bin/livekit-server.exe`) relays video between players. It's open source (Apache-2.0).
- **Web server** (`server/index.js`) serves the page over HTTPS, turns invite codes into short-lived
  LiveKit tokens, and passes LiveKit's connection through on the same address (`/rtc`).
  The LiveKit API secret never leaves this machine.
- **Invites** are random links stored in `data/invites.json`. Revoking one stops it working for new joins.

## First-time setup

```bash
npm install
npm run setup
```

`bin/` needs the LiveKit server. Get the Windows build (`livekit_<version>_windows_amd64.zip`) from
https://github.com/livekit/livekit/releases and put `livekit-server.exe` in `bin/`.

`npm run setup` creates `data/` with API keys, the LiveKit config and a self-signed HTTPS certificate
for this PC's network addresses. Re-run it with `-- --host <ip>` if your PC's address changes.

## Everyday use

```bash
npm run invite -- Jake          # make an invite link for Jake
npm run invite -- --list        # show all links
npm run invite -- --revoke Jake # turn Jake's link off
npm start                       # run the table (Ctrl+C to stop)
```

Each device that opens the site shows a certificate warning the first time, because the certificate is
self-signed. Choose "Advanced → Proceed". This is only for testing on your home network; a cloud
server will use a real certificate.

## Windows firewall (testing on your home network)

Other devices need to reach this PC on:

| Port | Protocol | Used for |
|---|---|---|
| 8443 | TCP | Web page and signaling (node.exe) |
| 7881 | TCP | Video fallback (livekit-server.exe) |
| 7882 | UDP | Video (livekit-server.exe) |

Set your home network to **Private** in Windows settings, and allow both programs on Private networks.

## At the table

- **Life, poison, commander damage, counters** on each video; **Game** panel for turn order,
  monarch/initiative, new game and the log. State is saved in `data/games.json`.
- **Tools bar:** *Sticker* (click a video to place P/T, modifiers, counters, text or a Scryfall card;
  click a sticker to edit or stack more on it; drag to move), *Pen* and *Arrow* (fade after 20 s unless
  "Drawings stay" is on), *Find card* (search Scryfall, then place the card as a sticker).
- **Game modes** (Game panel): Commander (40 life, commander damage), Brawl (25 life head-to-head,
  30 multiplayer, no commander damage), Standard (20 life). Starting life can be overridden.
- **Decks** panel: paste a deck list (Moxfield/Archidekt/Arena exports work); cards are looked up on
  Scryfall and anyone can browse them. A `Commander` section sets your commander; otherwise click ★.
  Commander chips show on your video with commander tax. Decks live in `data/decks.json`.
- A stack's big number is its effective P/T: the last card or "Set P/T" value, plus modifiers and
  +N/+N counters.
- Scryfall requests go through the server (`server/scryfall.js`), which caches them and stays under
  Scryfall's rate limit.

## Video stats

Each video tile shows live stats: what you're sending (resolution, fps, bitrate, and why quality is
being reduced if it is) and what you receive from each player. Hide them with the toolbar button.

## Data folder

`data/` holds secrets (API secret, certificate key, invite codes). It's in `.gitignore`. Never share it.

## Previewing the UI on this computer

Some browsers (and embedded previews) refuse the self-signed certificate. Start the server with
`MTG_DEV_HTTP=8080 npm start` to also serve plain HTTP on `http://127.0.0.1:8080`. It only listens on
this computer, never on the network.
