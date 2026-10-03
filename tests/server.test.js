import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { Notifier } from '../src/notifier.js';
import { PolymarketClient } from '../src/polymarket.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { Tracker } from '../src/tracker.js';
import { makeTrade, startMockPolymarket } from './helpers/mock-polymarket.js';

const ALICE = '0x9aeb534c42b58b21673d5e03e9da14fbd15b2729';
const BOB = '0x2110ba2a1e18840109482ff4ddc547baeff45850';
const quiet = { info() {}, warn() {}, error() {} };

async function startApp({ basicAuth = null, seed = { ai: [ALICE], geopolitics: [] } } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-server-'));
  const mock = await startMockPolymarket();
  const config = { pollIntervalMinutes: 5, minTradeUsd: 30, lateTradeGraceMinutes: 60, basicAuth };
  const store = new Store({ file: path.join(dir, 'state.json'), logger: quiet, seed });
  await store.load();
  const client = new PolymarketClient({ dataApiUrl: mock.url, gammaApiUrl: mock.url, sleep: async () => {}, logger: quiet });
  const notifier = new Notifier({}, { logger: quiet });
  const tracker = new Tracker({ store, client, notifier, config, logger: quiet, requestSpacingMs: 0 });
  const server = createServer({ tracker, notifier, config, logger: quiet });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    mock,
    store,
    tracker,
    async close() {
      tracker.stop();
      await tracker.idle();
      server.close();
      server.closeAllConnections();
      await mock.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const postJson = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

function openEventStream(base) {
  return new Promise((resolve, reject) => {
    const events = [];
    const request = http.get(`${base}/api/events`, (response) => {
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      });
      resolve({
        headers: response.headers,
        events,
        close: () => request.destroy(),
        async waitFor(name, timeoutMs = 5000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const found = events.find((item) => item.event === name);
            if (found) return found.data;
            await new Promise((done) => setTimeout(done, 20));
          }
          throw new Error(`No "${name}" event within ${timeoutMs} ms`);
        },
      });
    });
    request.on('error', reject);
  });
}

describe('HTTP server', () => {
  let app;
  afterEach(() => app?.close());

  test('serves the dashboard with security headers', async () => {
    app = await startApp();
    const page = await fetch(`${app.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /<title>Trader Tracker<\/title>/);

    for (const [file, type] of [['/app.js', /javascript/], ['/styles.css', /text\/css/], ['/favicon.svg', /svg/]]) {
      const response = await fetch(`${app.base}${file}`);
      assert.equal(response.status, 200, file);
      assert.match(response.headers.get('content-type'), type);
    }
    assert.equal((await fetch(`${app.base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${app.base}/src/server.js`)).status, 404);
    assert.deepEqual(await (await fetch(`${app.base}/healthz`)).json(), { ok: true });
  });

  test('GET /api/state lists categories, tracked accounts and conditions', async () => {
    app = await startApp();
    const state = await (await fetch(`${app.base}/api/state`)).json();
    assert.deepEqual(state.categories, [{ id: 'ai', name: 'AI' }, { id: 'geopolitics', name: 'Geopolitics' }]);
    assert.deepEqual(state.conditions, { takerOnly: true, minTradeUsd: 30 });
    assert.equal(state.traders.length, 1);
    assert.equal(state.traders[0].address, ALICE);
    assert.equal(state.traders[0].profileUrl, `https://polymarket.com/profile/${ALICE}`);
    assert.ok(state.traders[0].categories.ai.addedAt);
    assert.equal(state.channels.length, 5);
    assert.equal(state.status.running, false);
  });

  test('POST /api/traders adds accounts by profile URL and by username', async () => {
    app = await startApp();
    app.mock.profiles[BOB] = { name: 'bob', pseudonym: 'Quiet-Lake', proxyWallet: BOB };
    let response = await fetch(`${app.base}/api/traders`, postJson({
      category: 'geopolitics',
      input: `https://polymarket.com/profile/${BOB}`,
    }));
    assert.equal(response.status, 201);
    let body = await response.json();
    assert.equal(body.trader.displayName, 'bob');
    assert.equal(body.warning, null);

    app.mock.searchProfiles = [{ name: 'alice', pseudonym: 'Brave-Owl', proxyWallet: ALICE }];
    response = await fetch(`${app.base}/api/traders`, postJson({ category: 'geopolitics', input: '@alice' }));
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.created, false);

    const state = await (await fetch(`${app.base}/api/state`)).json();
    const geopolitics = state.traders.filter((trader) => trader.categories.geopolitics).map((trader) => trader.address);
    assert.deepEqual(geopolitics.sort(), [BOB, ALICE].sort());
  });

  test('POST /api/traders explains what is wrong with bad requests', async () => {
    app = await startApp();
    const cases = [
      [{ category: 'ai', input: 'hello world' }, 400],
      [{ category: 'ai', input: ALICE }, 409],
      [{ category: 'sports', input: BOB }, 400],
      [{ category: 'ai' }, 400],
    ];
    for (const [payload, status] of cases) {
      const response = await fetch(`${app.base}/api/traders`, postJson(payload));
      assert.equal(response.status, status, JSON.stringify(payload));
      assert.ok((await response.json()).error);
    }
    const invalid = await fetch(`${app.base}/api/traders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(invalid.status, 400);
  });

  test('DELETE /api/traders/:address stops tracking in a category', async () => {
    app = await startApp();
    const url = `${app.base}/api/traders/${ALICE}?category=ai`;
    let response = await fetch(url, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { removed: true, removedCompletely: true });
    response = await fetch(url, { method: 'DELETE' });
    assert.equal(response.status, 404);
  });

  test('POST /api/traders/:address/refresh reloads the profile name', async () => {
    app = await startApp();
    app.mock.profiles[ALICE] = { name: 'alice-renamed', proxyWallet: ALICE };
    const response = await fetch(`${app.base}/api/traders/${ALICE}/refresh`, postJson({}));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).trader.displayName, 'alice-renamed');
  });

  test('rejects writes that could come from another website', async () => {
    app = await startApp();
    let response = await fetch(`${app.base}/api/check`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(response.status, 415);
    response = await fetch(`${app.base}/api/check`, postJson({}, { origin: 'https://evil.example' }));
    assert.equal(response.status, 403);
    response = await fetch(`${app.base}/api/traders/${ALICE}?category=ai`, {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(response.status, 403);
    response = await fetch(`${app.base}/api/traders/${ALICE}?category=ai`, {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'same-site', origin: app.base },
    });
    assert.equal(response.status, 403);
    assert.ok(app.store.state.traders[ALICE], 'nothing was removed');
    response = await fetch(`${app.base}/api/check`, postJson({}, { origin: app.base }));
    assert.equal(response.status, 202);
    // Behind a reverse proxy that rewrites Host, browsers' same-origin metadata still passes.
    response = await fetch(`${app.base}/api/check`, postJson({}, {
      origin: 'https://tracker.example.com',
      'sec-fetch-site': 'same-origin',
    }));
    assert.equal(response.status, 202);
  });

  test('basic auth protects everything except the health check', async () => {
    app = await startApp({ basicAuth: { username: 'admin', password: 's3cret' } });
    const auth = (credentials) => ({ headers: { authorization: `Basic ${Buffer.from(credentials).toString('base64')}` } });
    let response = await fetch(`${app.base}/api/state`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Basic/);
    assert.equal((await fetch(`${app.base}/`, auth('admin:wrong'))).status, 401);
    assert.equal((await fetch(`${app.base}/api/state`, auth('admin:s3cret'))).status, 200);
    assert.equal((await fetch(`${app.base}/healthz`)).status, 200);
  });

  test('POST /api/check finds qualifying trades and streams them over SSE', async () => {
    app = await startApp();
    const after = Math.floor(Date.now() / 1000) + 5;
    app.mock.trades = [
      makeTrade({ user: ALICE, timestamp: after, size: 100, price: 0.45, outcome: 'No' }),
      makeTrade({ user: ALICE, timestamp: after + 1, size: 100, price: 0.45, role: 'maker' }),
      makeTrade({ user: ALICE, timestamp: after + 2, size: 40, price: 0.5 }),
      makeTrade({ user: ALICE, timestamp: after - 3600, size: 500, price: 0.5 }),
    ];
    const stream = await openEventStream(app.base);
    try {
      assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
      assert.equal((await stream.waitFor('status')).running, false);

      const response = await fetch(`${app.base}/api/check`, postJson({}));
      assert.equal(response.status, 202);
      assert.equal((await response.json()).started, true);

      const alerts = await stream.waitFor('alerts');
      assert.equal(alerts.length, 1, 'maker, small and pre-tracking trades are ignored');
      assert.equal(alerts[0].trade.usd, 45);
      assert.equal(alerts[0].trade.outcome, 'No');
      assert.deepEqual(alerts[0].categories, ['ai']);
      await app.tracker.idle();

      const state = await (await fetch(`${app.base}/api/state`)).json();
      assert.equal(state.alerts.length, 1);
      assert.equal(state.status.lastRun.newAlerts, 1);
      assert.equal(state.status.tradesApi, 'v2');
    } finally {
      stream.close();
    }
  });
});
