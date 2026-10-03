# Polymarket Trader Tracker

Watches selected [Polymarket](https://polymarket.com) accounts and notifies you when one of them makes a trade
that meets these conditions:

1. **The tracked account is the price taker.** Its order crossed the spread and took liquidity from the order book.
2. **The trade is worth more than $30.** Value is shares × price.

Accounts are organised in two tabs, **AI** and **Geopolitics**, each with its own list. Every account is checked
**every 5 minutes**.

There are two ways to run it:

- **On GitHub, with no server of your own** ([setup](#run-it-on-github-no-server-needed)). GitHub Actions does
  the checks and sends the notifications, and the dashboard is published as a web page on GitHub Pages.
- **On your own computer or server** ([quick start](#quick-start)). The dashboard is served by the app itself,
  and you can add or remove accounts directly in it.

## Features

- **Dashboard** with a **Last 24 hours** list of every notification, plus an AI tab and a Geopolitics tab. Each
  category tab lists its tracked accounts with their Polymarket name and full wallet address (ID), plus the
  qualifying trades found for them.
- **Pre-loaded AI accounts**: the nine requested accounts (listed in [`traders/ai.txt`](traders/ai.txt)) are
  tracked from the first start.
- **Add accounts** to either tab with a wallet address, a `polymarket.com/profile/0x…` link or an `@username`.
  Display names are loaded from the Polymarket profile. Optionally give an account your own label. One account can
  be in both tabs.
- **Remove accounts** with one click, per tab.
- **Notifications** via Telegram, Discord, Slack, [ntfy](https://ntfy.sh) (phone/desktop push), any webhook, and
  browser notifications while the dashboard is open.
- **Live updates**: new trades appear in the dashboard without a reload. There is also a **Check now** button and
  a **Send test** button for notifications.
- **No dependencies**: plain Node.js; state is kept in a JSON file.

## Run it on GitHub (no server needed)

The workflow in [`.github/workflows/tracker.yml`](.github/workflows/tracker.yml) runs every 5 minutes on GitHub's
servers. Each run checks Polymarket, sends notifications and publishes the dashboard. GitHub Actions is free for
public repositories.

1. **Publish the dashboard.** In the repository go to **Settings → Pages → Build and deployment → Source** and
   choose **GitHub Actions**. After the next run the dashboard is at
   `https://<your-github-username>.github.io/<repository>/`, for this repository
   <https://stasermilov.github.io/Tracker/>.
2. **Set up notifications** (optional). Go to **Settings → Secrets and variables → Actions → New repository
   secret** and add the same names as in the [Notifications](#notifications) table, for example `NTFY_TOPIC`, or
   `TELEGRAM_BOT_TOKEN` plus `TELEGRAM_CHAT_ID`. To change the $30 threshold, add a repository *variable*
   `MIN_TRADE_USD`.
3. **Run it once now** (optional): **Actions → Tracker → Run workflow**. Otherwise it starts on its own within
   about 5 minutes.

**Managing accounts:** the tracked accounts are the lines in [`traders/ai.txt`](traders/ai.txt) and
[`traders/geopolitics.txt`](traders/geopolitics.txt). Put one wallet address per line, optionally followed by a
space and a label. Edit them on GitHub (pencil icon → **Commit changes**). The **Add** form on the published
dashboard prepares the line for you and opens the right file. Committing a change starts a run straight away, so
the account appears within a minute or two.

Good to know:

- The first check of a newly listed account fills the dashboard with its qualifying trades from the past 24 hours.
  Only trades from the last hour are sent as notifications, so you are not flooded with old ones.
- GitHub runs schedules on a best-effort basis. When it is busy, runs start a few minutes late, so alerts may lag
  a little behind the trade. For a brand-new repository, GitHub sometimes takes much longer to start the schedule
  at all; see [below](#if-the-5-minute-schedule-doesnt-run).
- The published dashboard is public, like the repository. Its data comes from Polymarket's public API.
- Between runs, the tracker remembers what it has already reported on the `tracker-state` branch.
- To pause it: **Actions → Tracker → ⋯ → Disable workflow**. GitHub also pauses scheduled workflows after 60 days
  without repository activity. Re-enable it on the same page.
- If you also run the app yourself with the same notification settings, you will get every notification twice.

### If the 5-minute schedule doesn't run

The **Actions** tab lists every run with what started it. Scheduled runs say **schedule**. If none appear, GitHub's
scheduler has not picked the workflow up. A free external scheduler can start the workflow every 5 minutes
instead, which is also more punctual:

1. **Create a token that can only start workflows in this repository.** On GitHub go to **Settings → Developer
   settings → Personal access tokens → Fine-grained tokens → Generate new token**. Under **Repository access**
   choose **Only select repositories** and pick this repository. Under **Permissions → Repository permissions** set
   **Actions** to **Read and write**. Generate the token and copy it.
2. **Create a job at a scheduler such as [cron-job.org](https://cron-job.org)** (free account) with:
   - **URL:** `https://api.github.com/repos/<owner>/<repository>/actions/workflows/tracker.yml/dispatches`
   - **Schedule:** every 5 minutes
   - **Request method:** `POST`
   - **Headers:** `Authorization: Bearer <your token>` and `Accept: application/vnd.github+json`
   - **Request body:** `{"ref":"<default branch name>"}`

   GitHub answers `204 No Content` when it starts a run. The token can only start workflows; if it ever leaks,
   delete it on the same GitHub page.

## Quick start

Requires **Node.js 20 or newer**.

```bash
git clone https://github.com/stasermilov/Tracker.git
cd Tracker
cp .env.example .env     # optional: configure notifications (see below)
npm start
```

Open <http://localhost:3000>. The first check runs a few seconds after start, then every 5 minutes. The tracker
only checks and notifies while it is running, so run it on an always-on machine (a home server, a VPS, or Docker
with a restart policy).

### Docker

```bash
cp .env.example .env     # optional
docker compose up -d --build
```

The dashboard is published on <http://localhost:3000> (this machine only), and state is kept in the
`tracker-data` volume.

### Trying it out

1. Start the app and open the dashboard. Within a few seconds every account shows **Checked just now** and its
   Polymarket name. That confirms the app can reach Polymarket. If an account shows **⚠ Last check failed**, hover
   over it to see why.
2. Press **Send test** to check your notification channels, or turn on **Browser alerts**.
3. By default only trades made *after* an account starts being tracked alert, so the trade feed starts empty and
   fills as the accounts trade. To see real alerts straight away, start with fresh state and a look-back window:

   ```bash
   rm -f data/state.json      # only if you have run the app before
   BACKFILL_HOURS=24 npm start
   ```

   On Windows, or with Docker, put `BACKFILL_HOURS=24` in `.env` instead. The first check then also reports (and
   notifies about) qualifying trades from the past 24 hours. Remove the setting afterwards if you only want new
   trades for accounts you add later.

## Notifications

Configure any number of channels in `.env`, restart, then press **Send test** in the dashboard to confirm. Each
message has the trader, side (buy/sell), outcome, dollar value, shares and price, the market (linked), and links
to the trader's profile and the transaction.

| Channel | Settings | How to get them |
| --- | --- | --- |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Create a bot with [@BotFather](https://t.me/BotFather) and send it any message. Your chat id is in `https://api.telegram.org/bot<TOKEN>/getUpdates`. Separate several chat ids with commas. |
| Discord | `DISCORD_WEBHOOK_URL` | Server settings → Integrations → Webhooks → New Webhook → Copy URL. |
| Slack | `SLACK_WEBHOOK_URL` | Create an [incoming webhook](https://api.slack.com/messaging/webhooks) for a channel. |
| ntfy | `NTFY_TOPIC`, optional `NTFY_SERVER`, `NTFY_TOKEN` | Install the ntfy app and subscribe to a hard-to-guess topic name. Free, no account needed. |
| Webhook | `WEBHOOK_URL` | Receives `POST {"event":"trade_alert","title","text","alert":{…}}` for every alert. |
| Browser | (none) | Click **Browser alerts** in the dashboard. Works while the page is open, on `https://` or `localhost`. |

If more than 10 trades qualify in a single check, the first 10 are sent individually and the rest are combined
into one summary message.

## How it works

Every check, for each tracked account:

1. The app fetches the account's recent trades from Polymarket's public Data API, asking only for trades where
   the account was the **taker** and the cash value is at least the threshold:

   ```
   GET https://data-api.polymarket.com/v2/trades?user=<wallet>&taker_only=true&filter_type=CASH&filter_amount=30
   ```

   Polymarket's API returns only the taker side of each match when taker-only is requested. Maker fills (the
   account's resting limit orders being filled) are never returned, which is how the price-taker condition is
   enforced. If the v2 endpoint is unavailable, the app falls back to the legacy
   `GET /trades?user=…&takerOnly=true&filterType=CASH&filterAmount=30` automatically.
2. Each trade's value (`size × price`) must be **strictly greater** than `MIN_TRADE_USD`, so $30.00 exactly does
   not qualify.
3. Only trades made **after the account was added** alert (or up to `BACKFILL_HOURS` before, if set), and each
   trade alerts **once**. The app remembers which
   trades it has processed, so restarts never repeat alerts. Trades made while the app was offline are picked up
   on the next check. Trades that Polymarket's API reports a little late (up to `LATE_TRADE_GRACE_MINUTES`) are
   still caught.
4. New qualifying trades are saved to the alert history, pushed to open dashboards, and sent to every configured
   notification channel.

Display names come from `https://gamma-api.polymarket.com/public-profile?address=<wallet>` and refresh daily, or
on demand with the ↻ button.

**Which address to use:** track the address shown in the trader's profile URL (`polymarket.com/profile/0x…`),
which is their Polymarket wallet. If you paste the signer wallet instead and Polymarket's profile reports the
linked Polymarket wallet, the app switches to that wallet automatically and tells you.

## Configuration

All settings are optional environment variables, which can be put in `.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `POLL_INTERVAL_MINUTES` | `5` | How often to check Polymarket. |
| `MIN_TRADE_USD` | `30` | A trade must be worth more than this (shares × price). |
| `HOST` | `127.0.0.1` | Interface to listen on. Use `0.0.0.0` to allow other devices. |
| `PORT` | `3000` | Dashboard port. |
| `BASIC_AUTH` | (unset) | `user:password` to protect the dashboard. Set it whenever other machines can reach it. |
| `DATA_DIR` | `./data` | Where `state.json` (tracked accounts, alert history) is stored. |
| `LATE_TRADE_GRACE_MINUTES` | `60` | How late a trade may show up in the API and still alert. |
| `BACKFILL_HOURS` | `0` | When an account starts being tracked, also alert on its qualifying trades from the past N hours. |
| `NOTIFY_MAX_AGE_MINUTES` | `0` (no limit) | Only send notifications for trades at most this old; older ones are still listed. |
| `MAX_ALERTS` | `1000` | Alert history size. |
| `POLYMARKET_TRADES_API` | `auto` | `auto`, `v2` or `v1`. Selects the trades endpoint. |
| `POLYMARKET_DATA_API_URL`, `POLYMARKET_GAMMA_API_URL` | Polymarket | Override the API base URLs. |

Notification variables are listed in the [Notifications](#notifications) table and in [`.env.example`](.env.example).

To add another tab besides AI and Geopolitics, add it to `CATEGORIES` in [`src/config.js`](src/config.js).

## HTTP API

The dashboard uses a small JSON API that you can also script against. Write requests must send
`Content-Type: application/json`.

| Method & path | Purpose |
| --- | --- |
| `GET /api/state` | Categories, tracked accounts, recent alerts, scheduler status, channels. |
| `POST /api/traders` | Track an account: `{"category":"ai","input":"0x…" or URL or "@name","label":"optional"}`. |
| `DELETE /api/traders/<address>?category=ai` | Stop tracking an account in a category. |
| `POST /api/traders/<address>/refresh` | Reload the account's name from Polymarket. |
| `POST /api/check` | Run a check now. |
| `POST /api/test-notification` | Send a test message to every configured channel. |
| `GET /api/events` | Server-Sent Events stream (`status`, `alerts`, `traders`, `delivery`). |
| `GET /healthz` | Health check (no auth). |

## Development

```bash
npm test        # node:test suite, uses a local mock of the Polymarket APIs
npm run dev     # restart on file changes
```

Project layout:

```
src/polymarket.js   Polymarket Data/Gamma API client and trade normalisation
src/tracker.js      polling schedule, qualifying-trade detection, account management
src/notifier.js     Telegram / Discord / Slack / ntfy / webhook delivery
src/store.js        JSON state persistence
src/server.js       HTTP API, live event stream, static dashboard
src/run-once.js     single check for scheduled runs; writes the static dashboard
traders/            tracked accounts per tab (seed list; source of truth on GitHub)
public/             dashboard (vanilla HTML/CSS/JS)
tests/              test suite and Polymarket API mock
.github/workflows/  the scheduled GitHub Actions run
```
