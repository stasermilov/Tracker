import { categoryName as defaultCategoryName } from './config.js';
import { shortAddress } from './polymarket.js';

const usdFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const sharesFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function formatUsd(value) {
  return usdFormat.format(value);
}

export function formatShares(value) {
  return sharesFormat.format(value);
}

/** Polymarket quotes prices in cents: 0.62 -> "62¢", 0.625 -> "62.5¢". */
export function formatPrice(price) {
  const cents = Math.round(price * 1000) / 10;
  return `${Number.isInteger(cents) ? cents.toFixed(0) : cents.toFixed(1)}¢`;
}

export function formatUtc(epochSeconds) {
  return `${new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Everything a channel needs to render one alert. */
export function composeAlertMessage(alert, categoryName = defaultCategoryName) {
  const { trade } = alert;
  const side = trade.side === 'SELL' ? 'SELL' : 'BUY';
  const who = alert.trader.name || shortAddress(alert.trader.address);
  const verb = side === 'SELL' ? 'sold' : 'bought';
  const outcome = trade.outcome || 'shares';
  const usd = formatUsd(trade.usd);
  const shares = formatShares(trade.size);
  const price = formatPrice(trade.price);
  const market = trade.title || 'Unknown market';
  const categories = alert.categories.map(categoryName).join(', ');
  const time = formatUtc(trade.timestamp);
  const links = alert.links ?? {};
  const text = [
    `${who} ${verb} ${outcome} for ${usd} (price taker)`,
    market,
    `${shares} shares @ ${price} · ${categories} · ${time}`,
    links.market,
  ].filter(Boolean).join('\n');
  return {
    side,
    who,
    verb,
    outcome,
    usd,
    shares,
    price,
    market,
    categories,
    time,
    isoTime: new Date(trade.timestamp * 1000).toISOString(),
    links,
    title: `${side} ${usd} · ${who}`,
    text,
  };
}

function summaryMessage(alerts, categoryName) {
  const lines = alerts.slice(0, 10).map((alert) => {
    const message = composeAlertMessage(alert, categoryName);
    return `• ${message.who} ${message.verb} ${message.outcome} for ${message.usd} — ${message.market}`;
  });
  if (alerts.length > lines.length) lines.push(`• …and ${alerts.length - lines.length} more`);
  lines.push('Open the tracker dashboard for the full list.');
  return { title: `+${alerts.length} more qualifying trades`, text: lines.join('\n') };
}

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const escapeSlack = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeDiscord = (value) => String(value).replace(/([\\*_~`|>[\]()])/g, '\\$1');
const truncate = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function telegramChannel({ botToken, chatIds }, http) {
  const send = async (html) => {
    for (const chatId of chatIds) {
      await http.postJson(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    }
  };
  const link = (url, label) => (url ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` : escapeHtml(label));
  return {
    id: 'telegram',
    name: 'Telegram',
    minIntervalMs: 1100,
    sendAlert: (m) => send([
      `${m.side === 'BUY' ? '🟢' : '🔴'} <b>${m.side}</b> · ${escapeHtml(m.categories)}`,
      `<b>${escapeHtml(m.who)}</b> ${m.verb} <b>${escapeHtml(m.outcome)}</b> for <b>${m.usd}</b>`,
      `${m.shares} shares @ ${m.price} · price taker`,
      link(m.links.market, m.market),
      [link(m.links.profile, 'Trader profile'), m.links.tx && link(m.links.tx, 'Transaction')].filter(Boolean).join(' · '),
      `🕒 ${m.time}`,
    ].join('\n')),
    sendText: ({ title, text }) => send(`<b>${escapeHtml(title)}</b>\n${escapeHtml(text)}`),
  };
}

function discordChannel({ webhookUrl }, http) {
  const post = (body) => http.postJson(webhookUrl, { username: 'Polymarket Tracker', allowed_mentions: { parse: [] }, ...body });
  return {
    id: 'discord',
    name: 'Discord',
    minIntervalMs: 600,
    sendAlert: (m) => post({
      embeds: [{
        title: truncate(m.market, 256),
        url: m.links.market ?? undefined,
        description: `**${escapeDiscord(m.who)}** ${m.verb} **${escapeDiscord(m.outcome)}** for **${m.usd}**\n`
          + `${m.shares} shares @ ${m.price} · price taker`,
        color: m.side === 'BUY' ? 0x16a34a : 0xdc2626,
        fields: [
          { name: 'Category', value: m.categories, inline: true },
          { name: 'Trader', value: `[${escapeDiscord(m.who)}](${m.links.profile})`, inline: true },
          ...(m.links.tx ? [{ name: 'Transaction', value: `[Polygonscan](${m.links.tx})`, inline: true }] : []),
        ],
        timestamp: m.isoTime,
        footer: { text: 'Polymarket Trader Tracker' },
      }],
    }),
    sendText: ({ title, text }) => post({ content: truncate(`**${escapeDiscord(title)}**\n${escapeDiscord(text)}`, 2000) }),
  };
}

function slackChannel({ webhookUrl }, http) {
  const link = (url, label) => (url ? `<${url}|${escapeSlack(label).replace(/\|/g, '¦')}>` : escapeSlack(label));
  return {
    id: 'slack',
    name: 'Slack',
    minIntervalMs: 1100,
    sendAlert: (m) => http.postJson(webhookUrl, {
      text: [
        `${m.side === 'BUY' ? ':large_green_circle:' : ':red_circle:'} *${m.side}* · ${escapeSlack(m.categories)}`,
        `*${escapeSlack(m.who)}* ${m.verb} *${escapeSlack(m.outcome)}* for *${m.usd}* — ${m.shares} shares @ ${m.price} (price taker)`,
        [link(m.links.market, m.market), link(m.links.profile, 'trader'), m.links.tx && link(m.links.tx, 'tx')]
          .filter(Boolean).join(' · '),
        m.time,
      ].join('\n'),
      unfurl_links: false,
    }),
    sendText: ({ title, text }) => http.postJson(webhookUrl, { text: `*${escapeSlack(title)}*\n${escapeSlack(text)}` }),
  };
}

function ntfyChannel({ server, topic, token }, http) {
  // JSON publishing (POST to the server root) supports UTF-8 titles, which
  // header-based publishing does not.
  const post = (body) => http.postJson(`${server}/`, { topic, ...body }, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    id: 'ntfy',
    name: 'ntfy',
    minIntervalMs: 250,
    sendAlert: (m) => post({
      title: m.title,
      message: `${m.verb} ${m.outcome} @ ${m.price} (${m.shares} shares, price taker)\n${m.market}\n${m.categories} · ${m.time}`,
      tags: [m.side === 'BUY' ? 'green_circle' : 'red_circle'],
      priority: 4,
      ...(m.links.market ? { click: m.links.market } : {}),
      actions: [
        { action: 'view', label: 'Trader', url: m.links.profile },
        ...(m.links.tx ? [{ action: 'view', label: 'Transaction', url: m.links.tx }] : []),
      ],
    }),
    sendText: ({ title, text }) => post({ title, message: text }),
  };
}

function webhookChannel({ url }, http) {
  return {
    id: 'webhook',
    name: 'Webhook',
    minIntervalMs: 0,
    sendAlert: (m, alert) => http.postJson(url, { event: 'trade_alert', title: m.title, text: m.text, alert }),
    sendText: ({ title, text }) => http.postJson(url, { event: 'message', title, text }),
  };
}

const CHANNELS = [
  {
    id: 'telegram',
    name: 'Telegram',
    hint: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID',
    isConfigured: (c) => Boolean(c.telegram?.botToken && c.telegram?.chatIds?.length),
    create: (c, http) => telegramChannel(c.telegram, http),
  },
  {
    id: 'discord',
    name: 'Discord',
    hint: 'Set DISCORD_WEBHOOK_URL',
    isConfigured: (c) => Boolean(c.discord?.webhookUrl),
    create: (c, http) => discordChannel(c.discord, http),
  },
  {
    id: 'slack',
    name: 'Slack',
    hint: 'Set SLACK_WEBHOOK_URL',
    isConfigured: (c) => Boolean(c.slack?.webhookUrl),
    create: (c, http) => slackChannel(c.slack, http),
  },
  {
    id: 'ntfy',
    name: 'ntfy',
    hint: 'Set NTFY_TOPIC',
    isConfigured: (c) => Boolean(c.ntfy?.topic),
    create: (c, http) => ntfyChannel(c.ntfy, http),
  },
  {
    id: 'webhook',
    name: 'Webhook',
    hint: 'Set WEBHOOK_URL',
    isConfigured: (c) => Boolean(c.webhook?.url),
    create: (c, http) => webhookChannel(c.webhook, http),
  },
];

function retryDelayMs(response, text) {
  const header = Number(response.headers.get('retry-after'));
  if (response.headers.get('retry-after') && Number.isFinite(header) && header >= 0) return header * 1000;
  try {
    const body = JSON.parse(text);
    const seconds = Number(body.retry_after ?? body.parameters?.retry_after);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  } catch {
    // not JSON
  }
  return undefined;
}

function describeFailure(text) {
  try {
    const body = JSON.parse(text);
    const message = body.description ?? body.message ?? body.error;
    if (message) return `: ${String(message).slice(0, 200)}`;
  } catch {
    // not JSON
  }
  const snippet = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return snippet ? `: ${snippet}` : '';
}

// Errors never include the request URL: Telegram's contains the bot token.
async function postJson(fetchImpl, sleep, url, body, { headers = {}, timeoutMs = 15_000, attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    let text;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      if (attempt >= attempts) throw new Error(`network error: ${err.cause?.message ?? err.message}`);
      await sleep(1000 * attempt);
      continue;
    }
    if (response.ok) return text;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= attempts) throw new Error(`HTTP ${response.status}${describeFailure(text)}`);
    await sleep(Math.min(retryDelayMs(response, text) ?? 1000 * attempt, 30_000));
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends alerts to every configured push channel. */
export class Notifier {
  constructor(config = {}, {
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    logger = console,
    categoryName = defaultCategoryName,
    minTradeUsd = 30,
    maxIndividual = 10,
  } = {}) {
    const http = { postJson: (url, body, options) => postJson(fetchImpl, sleep, url, body, options) };
    this.sleep = sleep;
    this.logger = logger;
    this.categoryName = categoryName;
    this.minTradeUsd = minTradeUsd;
    this.maxIndividual = maxIndividual;
    this.status = CHANNELS.map(({ id, name, hint, isConfigured }) => ({ id, name, hint, configured: isConfigured(config) }));
    this.channels = CHANNELS.filter((channel) => channel.isConfigured(config)).map((channel) => channel.create(config, http));
  }

  get enabled() {
    return this.channels.length > 0;
  }

  describeChannels() {
    return this.status.map((channel) => ({ ...channel }));
  }

  /**
   * Sends one message per alert (oldest first) to each channel; alerts beyond
   * `maxIndividual` in one batch are folded into a single summary message.
   * @returns {Promise<Map<string, Record<string, true|string>>>} alert id ->
   *   channel id -> true, or the error message.
   */
  async notifyAlerts(alerts) {
    const results = new Map(alerts.map((alert) => [alert.id, {}]));
    const individual = alerts.slice(0, this.maxIndividual);
    const overflow = alerts.slice(this.maxIndividual);

    await Promise.all(this.channels.map(async (channel) => {
      let sent = 0;
      const pace = async () => {
        if (sent++ > 0 && channel.minIntervalMs) await this.sleep(channel.minIntervalMs);
      };
      for (const alert of individual) {
        await pace();
        try {
          await channel.sendAlert(composeAlertMessage(alert, this.categoryName), alert);
          results.get(alert.id)[channel.id] = true;
        } catch (err) {
          results.get(alert.id)[channel.id] = err.message;
          this.logger.warn(`${channel.name} notification failed: ${err.message}`);
        }
      }
      if (overflow.length) {
        await pace();
        let outcome = true;
        try {
          await channel.sendText(summaryMessage(overflow, this.categoryName));
        } catch (err) {
          outcome = err.message;
          this.logger.warn(`${channel.name} summary notification failed: ${err.message}`);
        }
        for (const alert of overflow) results.get(alert.id)[channel.id] = outcome;
      }
    }));
    return results;
  }

  /** Sends a test message to every configured channel. */
  async sendTest() {
    const message = {
      title: 'Test notification',
      text: 'Polymarket Trader Tracker can reach this channel. You will be notified here when a tracked '
        + `account is the price taker in a trade worth more than ${formatUsd(this.minTradeUsd)}.`,
    };
    return Promise.all(this.channels.map(async (channel) => {
      try {
        await channel.sendText(message);
        return { id: channel.id, name: channel.name, ok: true };
      } catch (err) {
        return { id: channel.id, name: channel.name, ok: false, error: err.message };
      }
    }));
  }
}
