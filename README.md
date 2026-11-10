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

### Host page

Run `npm run host-password` once (it prints a random password; or pass your own of 10+ characters),
restart the server, then open `/host` on the site. From there you can:

- make one invite link per player and table, working for 1 day, 1 week, 30 days or until revoked
- see who is online at each table
- revoke a link (anyone using it is disconnected straight away) or close a whole table

Changing the password logs out every logged-in browser. Repeated wrong passwords from one address are
blocked for 15 minutes, and so are addresses that try many invalid invite links.

### Public server

`npm run setup -- --domain mtg.example.com` switches to public-server mode: the app listens on
127.0.0.1:8080 with plain HTTP and a proxy such as Caddy serves HTTPS for the domain. Each table
allows up to 8 people (`maxPlayers` in `data/config.json`, then re-run setup).

### Deploying

A fresh Ubuntu server is set up once with `sudo bash deploy/install.sh <domain>` from a copy of this
folder (with `models/`). After that, every push to `main` deploys automatically through GitHub Actions
(`.github/workflows/deploy.yml`): the code is checked, uploaded over SSH with a deploy key that can only
run `/usr/local/sbin/mtg-deploy`, and installed by `deploy/update.sh`, which restarts the app and puts
the previous version back if it doesn't come up. Invites, decks, config and models on the server are
never touched. Deploys can also be started by hand from the repository's Actions tab.

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
- **Stickers follow cards:** a sticker placed on a card follows it when it's slid or tapped, and fades
  then goes away (with Undo) when the card leaves the table. The tracking runs in the browser of the
  player whose camera it is (`public/tracker.js`: the corner model through onnxruntime-web in a
  worker to find the card, then cheap template matching every frame), so it adds no load on the
  server. Positions go to the others over the call's data channel; resting positions are saved in the
  game state. Per sticker: "Follow the card under it" in the sticker editor. Per player: menu →
  "Stickers follow cards". Without the model files the stickers simply stay put.
- **Read cards held up:** hold a card up close to your camera and still for a moment; it's recognised
  (one lookup per card held up, against the decks at the table) and when you put it down on the table
  it gets a card sticker that follows it. An unsure match asks first; if it can't tell where the card
  went, the message offers "Place it myself". Runs in your browser (`public/autoread.js`): a tiny
  greyscale copy of the camera spots something big held still, the corner model checks it's a card.
  Per player: menu → "Read cards I hold up".
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

## Metrics (Prometheus / Grafana)

`GET /metrics` serves Prometheus metrics: who is connected and at which table
(`mtg_player_online`), how long the current connection has lasted (`mtg_player_session_seconds`),
total time and number of connections per player and table (`mtg_player_connected_seconds_total`,
`mtg_player_sessions_total`), server network traffic, and card lookups / decks loaded. Each join
and leave is also logged (`journalctl -u mtg-table | grep Player`) with the address, device and
duration.

It is off until you make a token: on the server run
`sudo -u mtg npm --prefix /opt/mtg-table run metrics-token`, then `sudo systemctl restart mtg-table`.
Scrape it with that token (Prometheus `authorization: { credentials: <token> }`, or Grafana Alloy's
`bearer_token`). Each address gets 20 requests a minute; 5 wrong tokens in an hour block the
address, and fail2ban bans it for a day. `npm run metrics-token -- off` turns it off again.

Handy queries: hours per player this month,
`sum by (name) (increase(mtg_player_connected_seconds_total[30d])) / 3600`; who is on now,
`mtg_player_session_seconds / 60`.

## Data folder

`data/` holds secrets (API secret, certificate key, invite codes). It's in `.gitignore`. Never share it.

## Previewing the UI on this computer

Some browsers (and embedded previews) refuse the self-signed certificate. Start the server with
`MTG_DEV_HTTP=8080 npm start` to also serve plain HTTP on `http://127.0.0.1:8080`. It only listens on
this computer, never on the network.
