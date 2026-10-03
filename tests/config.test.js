import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig, loadEnvFile } from '../src/config.js';

test('defaults match the tracking rules: every 5 minutes, trades over $30', () => {
  const config = loadConfig({});
  assert.equal(config.pollIntervalMinutes, 5);
  assert.equal(config.minTradeUsd, 30);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.basicAuth, null);
  assert.equal(config.backfillHours, 0, 'only trades after an account is added alert by default');
  assert.equal(loadConfig({ BACKFILL_HOURS: '24' }).backfillHours, 24);
  assert.equal(config.polymarket.tradesApi, 'auto');
  assert.equal(config.polymarket.dataApiUrl, 'https://data-api.polymarket.com');
});

test('reads notification settings', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_CHAT_ID: '111, -222',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x',
    NTFY_TOPIC: 'topic',
    NTFY_SERVER: 'https://ntfy.example.com/',
    BASIC_AUTH: 'admin:pa:ss',
  });
  assert.deepEqual(config.notifications.telegram, { botToken: 'token', chatIds: ['111', '-222'] });
  assert.equal(config.notifications.discord.webhookUrl, 'https://discord.com/api/webhooks/1/x');
  assert.equal(config.notifications.ntfy.server, 'https://ntfy.example.com');
  assert.deepEqual(config.basicAuth, { username: 'admin', password: 'pa:ss' });
});

test('rejects invalid values with a helpful message', () => {
  assert.throws(() => loadConfig({ POLL_INTERVAL_MINUTES: '0' }), /POLL_INTERVAL_MINUTES/);
  assert.throws(() => loadConfig({ MIN_TRADE_USD: 'thirty' }), /MIN_TRADE_USD/);
  assert.throws(() => loadConfig({ PORT: '3000.5' }), /PORT/);
  assert.throws(() => loadConfig({ BACKFILL_HOURS: '-1' }), /BACKFILL_HOURS/);
  assert.throws(() => loadConfig({ DISCORD_WEBHOOK_URL: 'not a url' }), /DISCORD_WEBHOOK_URL/);
  assert.throws(() => loadConfig({ BASIC_AUTH: 'nopassword' }), /BASIC_AUTH/);
  assert.throws(() => loadConfig({ POLYMARKET_TRADES_API: 'v3' }), /POLYMARKET_TRADES_API/);
});

test('loadEnvFile reads quotes and comments without overriding existing variables', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-env-'));
  const file = path.join(dir, '.env');
  await fs.writeFile(file, [
    '# comment',
    'PORT=4000',
    'NTFY_TOPIC="my topic" ',
    "export HOST='0.0.0.0'",
    'MIN_TRADE_USD=50 # inline comment',
    'TELEGRAM_CHAT_ID=1',
    'not a variable',
  ].join('\n'));
  const env = { TELEGRAM_CHAT_ID: 'already-set' };
  assert.equal(loadEnvFile(file, env), true);
  assert.deepEqual(env, {
    TELEGRAM_CHAT_ID: 'already-set',
    PORT: '4000',
    NTFY_TOPIC: 'my topic',
    HOST: '0.0.0.0',
    MIN_TRADE_USD: '50',
  });
  assert.equal(loadEnvFile(path.join(dir, 'missing.env'), env), false);
  await fs.rm(dir, { recursive: true, force: true });
});
