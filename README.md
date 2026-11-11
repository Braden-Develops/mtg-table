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
- **Identify** (tools bar): click a card on anyone's video to find out what it is. It is matched
  against the decks loaded at the table and shown as a sure "Match" or a "Best guess" with the other
  close candidates; see [Card recognition](#card-recognition).
- **Space** passes the turn on your own turn (not while typing or with a dialog open).
- **Game modes** (Game panel): Commander (40 life, commander damage), Brawl (25 life head-to-head,
  30 multiplayer, no commander damage), Standard (20 life). Starting life can be overridden.
- **Decks** panel: paste a deck list (Moxfield/Archidekt/Arena exports work); cards are looked up on
  Scryfall and anyone can browse them. A `Commander` section sets your commander; otherwise click ★.
  Exports that name the printing (`1 Sol Ring (C21) 263`) load that exact printing, which is also
  the one card recognition learns first.
  Commander chips show on your video with commander tax. Decks live in `data/decks.json`.
- A stack's big number is its effective P/T: the last card or "Set P/T" value, plus modifiers and
  +N/+N counters.
- Scryfall requests go through the server (`server/scryfall.js`), which caches them and stays under
  Scryfall's rate limit.

## Card recognition

Needs the two model files in `models/` (see Deploying). How a lookup works (`server/recognize.js`):

1. **Find the card's corners.** The corner model only works on a card shown the way it was trained:
   upright in a tall 9:16 frame, filling about half its width (then it is accurate to a pixel or two;
   on any other crop it is off by 10-30% of the card). `public/cardfind.js` tries such frames around
   the click until the model is sure. The same file drives sticker tracking and held-card reading in
   the browser.
2. **Compare with reference pictures** of every different-looking printing of each deck card (from
   Scryfall, cached in `data/references-v4.bin`; a new deck's own printings are ready in about a
   minute, the rest follow in the background). Two comparisons are added up: the embedding model,
   and a plain 32×45 colour and contrast comparison that also tries the outline trimmed a little on
   each side (sleeves, loose outlines on dark mats).
3. **Decide how sure it is.** A "Match" has to stand well clear of the next card; otherwise it's a
   "Best guess", and if nothing stands out the dialog says the card may not be in a loaded deck.

**Measuring it.** Every lookup is kept in `data/identify-log/` (the cropped camera picture, the
answer, and what the player then picked); the newest 400 are kept, about 60 MB. `RECOG_LOG_MAX=0`
in the service file turns that off, or set another number. To see how the current code does on them:

```bash
node scripts/recog-replay.js       # add -v to list every lookup
```

Copy lookups worth keeping as a permanent test set into `data/identify-fixtures/` (same layout; put
the right card name in `label.json`). Run this before and after changing anything in recognition.

`RECOG_THREADS=1` makes lookups use one CPU core instead of two, leaving the other for video on a
two-core server (lookups take about twice as long). `/metrics` has `mtg_card_identify_result_total`
(match / guess / no_card).

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

### Oracle Cloud spend

On the Oracle server (with the vault set up), `/metrics` also shows what the tenancy is costing,
refreshed hourly: `oci_cost_month_to_date` and `oci_cost_month_to_date_by_service` (from the Usage
API), and for each budget `oci_budget_amount`, `oci_budget_actual_spend` and
`oci_budget_forecast_spend`. Oracle's figures run several hours behind (up to about a day), so treat
them as "spend as of Oracle's last update". The VM only gets read access to cost and budgets. It
can't change anything or see payment details.

To switch it on, run [deploy/oci-vault-setup.sh](deploy/oci-vault-setup.sh) again in Cloud Shell. It
adds the read-only `mtg-table-cost` policy. Pass `BUDGET` and `ALERT_EMAIL` to also create a monthly
budget, which emails you at 50% and 100% of actual spend and when Oracle forecasts going over:

    curl -fsSL https://raw.githubusercontent.com/Braden-Develops/mtg-table/main/deploy/oci-vault-setup.sh | BUDGET=10 ALERT_EMAIL=you@example.com bash

Oracle sends those emails itself, so they arrive even if the VM is down. Then restart the app
(`sudo systemctl restart mtg-table`). Until the policy exists the app logs
`OCI cost (Usage API) unavailable` once and leaves the cost metrics out.

Handy Grafana alert: `oci_cost_month_to_date > 0` (or above whatever you expect to pay).

## Discord bot

Send invite links from Discord instead of the host page: right-click a friend > Apps >
**Invite to MTG table**, pick a table, and the bot DMs them the link (if it can't, you get the link and
a button to post it in the chat you're in). Also `/invite`, `/links`, `/revoke` and `/who`. Only your
Discord account can use them.

Set it up from the **Discord bot** section at the bottom of the host page; it walks through the
Developer Portal steps. Discord sends commands to `POST /api/discord`, signed with your application's
key; unsigned or old requests are refused. Any existing bot application works.

## Secrets in OCI Vault (Oracle server)

On the Oracle server the LiveKit API secret (which also signs host logins) and the Discord bot token
live in OCI Vault, not on disk. The server reads them at startup using the VM's own Oracle identity,
so there is no vault password stored anywhere either.

1. In the Oracle console, open Cloud Shell and run
   `curl -fsSL https://raw.githubusercontent.com/Braden-Develops/mtg-table/main/deploy/oci-vault-setup.sh | bash`
   (vault, key, secrets and an access policy for this VM only; all in the free tier).
2. On the server: `sudo -u mtg node /opt/mtg-table/scripts/vault.js on`, then `sudo systemctl restart mtg-table`.

`vault.js status` checks it; `vault.js off` copies the secrets back into `data/config.json`. If the
vault can't be reached at startup the server retries for about 40 seconds, then exits and systemd
tries again.

## Data folder

`data/` holds secrets (API secret, certificate key, invite codes). It's in `.gitignore`. Never share it.

## Previewing the UI on this computer

Some browsers (and embedded previews) refuse the self-signed certificate. Start the server with
`MTG_DEV_HTTP=8080 npm start` to also serve plain HTTP on `http://127.0.0.1:8080`. It only listens on
this computer, never on the network.
