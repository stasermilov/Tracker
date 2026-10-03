import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { composeAlertMessage, formatPrice, formatUsd, Notifier } from '../src/notifier.js';

const quiet = { info() {}, warn() {}, error() {} };
const ADDRESS = '0x9aeb534c42b58b21673d5e03e9da14fbd15b2729';

function sampleAlert(overrides = {}) {
  return {
    id: 'alert-1',
    createdAt: 1_790_000_100_000,
    categories: ['ai'],
    trader: { address: ADDRESS, name: 'alice' },
    trade: {
      side: 'BUY',
      outcome: 'Yes',
      outcomeIndex: 0,
      size: 152.3,
      price: 0.62,
      usd: 94.426,
      timestamp: 1_790_000_000,
      title: 'Will <AI> & robots win?',
      slug: 'ai-robots',
      eventSlug: 'ai-robots',
      transactionHash: '0xhash',
    },
    links: {
      market: 'https://polymarket.com/event/ai-robots',
      profile: `https://polymarket.com/profile/${ADDRESS}`,
      tx: 'https://polygonscan.com/tx/0xhash',
    },
    ...overrides,
  };
}

function recordingFetch(respond = () => ({ status: 200, body: '{"ok":true}' })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const { status, body = '', headers = {} } = respond(calls.length, String(url));
    return new Response(status === 204 ? null : body, { status, headers });
  };
  return { calls, fetchImpl };
}

function notifierFor(config, fetchImpl, options = {}) {
  const sleeps = [];
  const notifier = new Notifier(config, {
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms),
    logger: quiet,
    ...options,
  });
  return { notifier, sleeps };
}

describe('formatting', () => {
  test('prices are shown in cents', () => {
    assert.equal(formatPrice(0.62), '62¢');
    assert.equal(formatPrice(0.625), '62.5¢');
    assert.equal(formatPrice(0.57), '57¢');
    assert.equal(formatPrice(0.001), '0.1¢');
  });

  test('amounts are shown in dollars and cents', () => {
    assert.equal(formatUsd(94.426), '$94.43');
    assert.equal(formatUsd(1234.5), '$1,234.50');
  });

  test('composeAlertMessage summarizes the trade', () => {
    const message = composeAlertMessage(sampleAlert());
    assert.equal(message.title, 'BUY $94.43 · alice');
    assert.equal(message.categories, 'AI');
    assert.match(message.text, /^alice bought Yes for \$94\.43 \(price taker\)$/m);
    assert.match(message.text, /152\.3 shares @ 62¢ · AI · 2026-09-21 \d\d:\d\d UTC/);
  });

  test('falls back to a short address when the trader has no name', () => {
    const message = composeAlertMessage(sampleAlert({ trader: { address: ADDRESS, name: null } }));
    assert.equal(message.who, '0x9aeb…2729');
  });
});

describe('channels', () => {
  test('Telegram sends escaped HTML to every chat id', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const { notifier } = notifierFor({ telegram: { botToken: 'TOKEN', chatIds: ['1', '2'] } }, fetchImpl);
    const results = await notifier.notifyAlerts([sampleAlert()]);
    assert.deepEqual(calls.map((call) => call.url), [
      'https://api.telegram.org/botTOKEN/sendMessage',
      'https://api.telegram.org/botTOKEN/sendMessage',
    ]);
    assert.deepEqual(calls.map((call) => call.body.chat_id), ['1', '2']);
    assert.equal(calls[0].body.parse_mode, 'HTML');
    assert.match(calls[0].body.text, /<b>alice<\/b> bought <b>Yes<\/b> for <b>\$94\.43<\/b>/);
    assert.match(calls[0].body.text, /Will &lt;AI&gt; &amp; robots win\?/);
    assert.deepEqual(results.get('alert-1'), { telegram: true });
  });

  test('Discord sends an embed without pinging anyone', async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({ status: 204 }));
    const { notifier } = notifierFor({ discord: { webhookUrl: 'https://discord.test/hook' } }, fetchImpl);
    await notifier.notifyAlerts([sampleAlert()]);
    const [{ body }] = calls;
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal(body.embeds[0].title, 'Will <AI> & robots win?');
    assert.equal(body.embeds[0].url, 'https://polymarket.com/event/ai-robots');
    assert.equal(body.embeds[0].color, 0x16a34a);
    assert.equal(body.embeds[0].timestamp, '2026-09-21T14:13:20.000Z');
  });

  test('Slack escapes text and formats links', async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({ status: 200, body: 'ok' }));
    const { notifier } = notifierFor({ slack: { webhookUrl: 'https://hooks.slack.test/x' } }, fetchImpl);
    await notifier.notifyAlerts([sampleAlert()]);
    assert.match(calls[0].body.text, /<https:\/\/polymarket\.com\/event\/ai-robots\|Will &lt;AI&gt; &amp; robots win\?>/);
  });

  test('ntfy publishes JSON to the server root with the access token', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const config = { ntfy: { server: 'https://ntfy.test', topic: 'my-topic', token: 'secret' } };
    const { notifier } = notifierFor(config, fetchImpl);
    await notifier.notifyAlerts([sampleAlert()]);
    assert.equal(calls[0].url, 'https://ntfy.test/');
    assert.equal(calls[0].headers.authorization, 'Bearer secret');
    assert.equal(calls[0].body.topic, 'my-topic');
    assert.equal(calls[0].body.title, 'BUY $94.43 · alice');
    assert.equal(calls[0].body.click, 'https://polymarket.com/event/ai-robots');
  });

  test('the generic webhook receives the full alert', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const { notifier } = notifierFor({ webhook: { url: 'https://example.test/hook' } }, fetchImpl);
    await notifier.notifyAlerts([sampleAlert()]);
    assert.equal(calls[0].body.event, 'trade_alert');
    assert.equal(calls[0].body.alert.id, 'alert-1');
  });
});

describe('delivery', () => {
  test('retries rate limits using the delay the service asks for', async () => {
    const { calls, fetchImpl } = recordingFetch((n) => (n === 1
      ? { status: 429, body: '{"ok":false,"parameters":{"retry_after":3}}' }
      : { status: 200, body: '{"ok":true}' }));
    const { notifier, sleeps } = notifierFor({ telegram: { botToken: 'T', chatIds: ['1'] } }, fetchImpl);
    const results = await notifier.notifyAlerts([sampleAlert()]);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [3000]);
    assert.deepEqual(results.get('alert-1'), { telegram: true });
  });

  test('a failing channel is reported without affecting the others', async () => {
    const { fetchImpl } = recordingFetch((n, url) => (url.includes('discord')
      ? { status: 400, body: '{"message":"Invalid Webhook Token"}' }
      : { status: 200, body: '{"ok":true}' }));
    const config = {
      telegram: { botToken: 'T', chatIds: ['1'] },
      discord: { webhookUrl: 'https://discord.test/hook' },
    };
    const { notifier } = notifierFor(config, fetchImpl);
    const results = await notifier.notifyAlerts([sampleAlert()]);
    assert.deepEqual(results.get('alert-1'), { telegram: true, discord: 'HTTP 400: Invalid Webhook Token' });
  });

  test('alerts beyond the per-batch limit are folded into one summary', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const { notifier, sleeps } = notifierFor({ webhook: { url: 'https://example.test/hook' } }, fetchImpl, { maxIndividual: 2 });
    const alerts = Array.from({ length: 5 }, (_, i) => sampleAlert({ id: `alert-${i}` }));
    const results = await notifier.notifyAlerts(alerts);
    assert.deepEqual(calls.map((call) => call.body.event), ['trade_alert', 'trade_alert', 'message']);
    assert.equal(calls[2].body.title, '+3 more qualifying trades');
    assert.deepEqual([...results.values()], alerts.map(() => ({ webhook: true })));
    assert.deepEqual(sleeps, [], 'the webhook channel is not paced');
  });

  test('messages to rate-limited services are paced', async () => {
    const { fetchImpl } = recordingFetch();
    const { notifier, sleeps } = notifierFor({ telegram: { botToken: 'T', chatIds: ['1'] } }, fetchImpl);
    await notifier.notifyAlerts([sampleAlert({ id: 'a' }), sampleAlert({ id: 'b' }), sampleAlert({ id: 'c' })]);
    assert.deepEqual(sleeps, [1100, 1100]);
  });

  test('sendTest reports a result per configured channel', async () => {
    const { fetchImpl } = recordingFetch((n, url) => (url.includes('ntfy') ? { status: 500, body: 'down' } : { status: 200 }));
    const config = { ntfy: { server: 'https://ntfy.test', topic: 't' }, webhook: { url: 'https://example.test/hook' } };
    const { notifier } = notifierFor(config, fetchImpl);
    const results = await notifier.sendTest();
    assert.deepEqual(results, [
      { id: 'ntfy', name: 'ntfy', ok: false, error: 'HTTP 500: down' },
      { id: 'webhook', name: 'Webhook', ok: true },
    ]);
  });

  test('describeChannels lists every channel with its configured state', () => {
    const { notifier } = notifierFor({ slack: { webhookUrl: 'https://hooks.slack.test/x' } }, async () => new Response());
    const channels = notifier.describeChannels();
    assert.deepEqual(channels.map((channel) => [channel.id, channel.configured]), [
      ['telegram', false],
      ['discord', false],
      ['slack', true],
      ['ntfy', false],
      ['webhook', false],
    ]);
    assert.equal(notifier.enabled, true);
    assert.equal(new Notifier({}, { logger: quiet }).enabled, false);
  });
});
