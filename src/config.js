import fs from 'node:fs';
import path from 'node:path';

/** Dashboard tabs. A tracked trader can belong to any number of them. */
export const CATEGORIES = Object.freeze([
  Object.freeze({ id: 'ai', name: 'AI' }),
  Object.freeze({ id: 'geopolitics', name: 'Geopolitics' }),
]);

/** Accounts tracked on first start, before any state has been saved. */
export const SEED_TRADERS = Object.freeze({
  ai: Object.freeze([
    '0x9aeb534c42b58b21673d5e03e9da14fbd15b2729',
    '0x2110ba2a1e18840109482ff4ddc547baeff45850',
    '0xb10047d6a254b2ebb306d7a7d13bf59171ab6461',
    '0x736539924a5602b37a03a54fc12c1cc8f98964da',
    '0xbf93328f8b69273453228a82c913207731822fd7',
    '0x8a4c788f043023b8b28a762216d037e9f148532b',
    '0x564f22744b7941ade18d5e0e4f347c30e3057026',
    '0x28b291aa82da13e1d58993873806c92908d5eb4f',
    '0xb89f5425341719d298dc2f5b9a92374f5fde1c44',
  ]),
  geopolitics: Object.freeze([]),
});

export function categoryName(id) {
  return CATEGORIES.find((category) => category.id === id)?.name ?? id;
}

/**
 * Loads KEY=VALUE lines from a .env file into `env` without overriding
 * variables that are already set. Returns false when the file doesn't exist.
 */
export function loadEnvFile(file, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest.trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

function readNumber(env, key, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid ${key}="${raw}": expected a ${integer ? 'whole ' : ''}number from ${min} to ${max}`);
  }
  return value;
}

function readUrl(env, key, fallback) {
  const raw = (env[key] ?? '').trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http(s)');
  } catch {
    throw new Error(`Invalid ${key}: expected an http(s) URL`);
  }
  return raw;
}

function parseBasicAuth(raw) {
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error('Invalid BASIC_AUTH: expected "username:password"');
  }
  return { username: raw.slice(0, separator), password: raw.slice(separator + 1) };
}

export function loadConfig(env = process.env) {
  const tradesApi = (env.POLYMARKET_TRADES_API || 'auto').trim().toLowerCase();
  if (!['auto', 'v2', 'v1'].includes(tradesApi)) {
    throw new Error('Invalid POLYMARKET_TRADES_API: expected auto, v2 or v1');
  }
  const trimSlash = (url) => url.replace(/\/+$/, '');

  return {
    host: env.HOST || '127.0.0.1',
    port: readNumber(env, 'PORT', 3000, { min: 0, max: 65535, integer: true }),
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    pollIntervalMinutes: readNumber(env, 'POLL_INTERVAL_MINUTES', 5, { min: 1, max: 1440 }),
    minTradeUsd: readNumber(env, 'MIN_TRADE_USD', 30, { min: 0 }),
    lateTradeGraceMinutes: readNumber(env, 'LATE_TRADE_GRACE_MINUTES', 60, { min: 0, max: 10080 }),
    maxAlerts: readNumber(env, 'MAX_ALERTS', 1000, { min: 10, max: 100000, integer: true }),
    basicAuth: env.BASIC_AUTH ? parseBasicAuth(env.BASIC_AUTH) : null,
    polymarket: {
      dataApiUrl: trimSlash(readUrl(env, 'POLYMARKET_DATA_API_URL', 'https://data-api.polymarket.com')),
      gammaApiUrl: trimSlash(readUrl(env, 'POLYMARKET_GAMMA_API_URL', 'https://gamma-api.polymarket.com')),
      tradesApi,
    },
    notifications: {
      telegram: {
        botToken: (env.TELEGRAM_BOT_TOKEN || '').trim(),
        chatIds: (env.TELEGRAM_CHAT_ID || '').split(',').map((id) => id.trim()).filter(Boolean),
      },
      discord: { webhookUrl: readUrl(env, 'DISCORD_WEBHOOK_URL', '') },
      slack: { webhookUrl: readUrl(env, 'SLACK_WEBHOOK_URL', '') },
      ntfy: {
        server: trimSlash(readUrl(env, 'NTFY_SERVER', 'https://ntfy.sh')),
        topic: (env.NTFY_TOPIC || '').trim(),
        token: (env.NTFY_TOKEN || '').trim(),
      },
      webhook: { url: readUrl(env, 'WEBHOOK_URL', '') },
    },
  };
}
