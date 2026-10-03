import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { newTraderRecord, Store } from '../src/store.js';
import { selectNewTrades, Tracker, UserError } from '../src/tracker.js';

const ALICE = '0x9aeb534c42b58b21673d5e03e9da14fbd15b2729';
const BOB = '0x2110ba2a1e18840109482ff4ddc547baeff45850';
const quiet = { info() {}, warn() {}, error() {} };
const T0 = 1_790_000_000; // seconds

describe('selectNewTrades', () => {
  const trader = (overrides = {}) => ({ ...newTraderRecord(ALICE, T0 * 1000), ...overrides });
  const trade = (timestamp, usd, key = `k${timestamp}`) => ({ key, timestamp, usd });
  const options = { minUsd: 30, graceSeconds: 3600 };

  test('only trades worth strictly more than the threshold qualify', () => {
    const { fresh } = selectNewTrades(trader(), [trade(T0 + 1, 30), trade(T0 + 2, 30.01), trade(T0 + 3, 12)], options);
    assert.deepEqual(fresh.map((item) => item.usd), [30.01]);
  });

  test('ignores trades made before tracking started', () => {
    const { fresh, lastTradeTs } = selectNewTrades(trader(), [trade(T0 - 5, 100), trade(T0, 100)], options);
    assert.deepEqual(fresh.map((item) => item.timestamp), [T0]);
    assert.equal(lastTradeTs, T0);
  });

  test('never returns the same trade twice', () => {
    const trades = [trade(T0 + 10, 50), trade(T0 + 20, 60)];
    const first = selectNewTrades(trader(), trades, options);
    assert.equal(first.fresh.length, 2);
    const second = selectNewTrades(trader({ seen: first.seen, lastTradeTs: first.lastTradeTs }), trades, options);
    assert.equal(second.fresh.length, 0);
  });

  test('picks up a late-reported trade inside the grace window, but not old history', () => {
    const state = trader({ seen: { k: T0 + 7200 }, lastTradeTs: T0 + 7200 });
    const { fresh } = selectNewTrades(state, [trade(T0 + 7200 - 600, 50), trade(T0 + 7200 - 4000, 50)], options);
    assert.deepEqual(fresh.map((item) => item.timestamp), [T0 + 7200 - 600]);
  });

  test('prunes remembered keys that fell out of the grace window', () => {
    const state = trader({ seen: { old: T0 + 10 }, lastTradeTs: T0 + 10 });
    const { seen } = selectNewTrades(state, [trade(T0 + 10_000, 50, 'new')], options);
    assert.deepEqual(Object.keys(seen), ['new']);
  });

  test('returns new trades oldest first without mutating the trader', () => {
    const state = trader();
    const { fresh } = selectNewTrades(state, [trade(T0 + 30, 50), trade(T0 + 10, 50), trade(T0 + 20, 50)], options);
    assert.deepEqual(fresh.map((item) => item.timestamp), [T0 + 10, T0 + 20, T0 + 30]);
    assert.deepEqual(state.seen, {});
    assert.equal(state.lastTradeTs, 0);
  });
});

function fakeClient() {
  return {
    trades: {},
    profiles: {},
    searchResults: [],
    failFor: new Set(),
    calls: [],
    tradesApiInUse: 'v2',
    async getTakerTrades(address, options) {
      this.calls.push({ address, options });
      if (this.failFor.has(address)) throw new Error('boom');
      return (this.trades[address] ?? []).map((trade) => ({ ...trade }));
    },
    async getProfile(address) {
      return this.profiles[address] ?? null;
    },
    async searchProfiles() {
      return this.searchResults;
    },
  };
}

function fakeNotifier() {
  return {
    enabled: true,
    batches: [],
    async notifyAlerts(alerts) {
      this.batches.push(alerts);
      return new Map(alerts.map((alert) => [alert.id, { test: true }]));
    },
    describeChannels: () => [],
  };
}

function tradeRow(overrides = {}) {
  const timestamp = overrides.timestamp ?? T0 + 60;
  return {
    key: `0xhash|${timestamp}|asset|BUY|100|0.5`,
    wallet: ALICE,
    side: 'BUY',
    asset: 'asset',
    conditionId: '0xcond',
    size: 100,
    price: 0.5,
    usd: 50,
    timestamp,
    title: 'Will AI pass the bar?',
    slug: 'ai-bar',
    eventSlug: 'ai-bar',
    outcome: 'Yes',
    outcomeIndex: 0,
    name: 'alice',
    pseudonym: null,
    profileImage: null,
    transactionHash: '0xhash',
    ...overrides,
  };
}

describe('Tracker', () => {
  let dir;
  let store;
  let client;
  let notifier;
  let tracker;
  let nowMs;

  async function setup(seed = { ai: [ALICE], geopolitics: [] }, { backfillHours = 0 } = {}) {
    store = new Store({
      file: path.join(dir, 'state.json'),
      now: () => nowMs,
      logger: quiet,
      seed,
      backfillSeconds: backfillHours * 3600,
    });
    await store.load();
    client = fakeClient();
    notifier = fakeNotifier();
    tracker = new Tracker({
      store,
      client,
      notifier,
      config: { pollIntervalMinutes: 5, minTradeUsd: 30, lateTradeGraceMinutes: 60, backfillHours },
      logger: quiet,
      now: () => nowMs,
      requestSpacingMs: 0,
    });
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-test-'));
    nowMs = T0 * 1000;
  });

  afterEach(async () => {
    tracker?.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('alerts once per new qualifying trade and sends it to the notifier', async () => {
    await setup();
    client.trades[ALICE] = [tradeRow({ timestamp: T0 - 600, key: 'old' })];
    let run = await tracker.runCheck();
    assert.equal(run.newAlerts, 0, 'history from before tracking started is ignored');

    nowMs += 5 * 60_000;
    client.trades[ALICE].unshift(tradeRow({ timestamp: T0 + 120, key: 'new' }));
    run = await tracker.runCheck();
    assert.equal(run.newAlerts, 1);
    assert.equal(notifier.batches.length, 1);
    const [alert] = notifier.batches[0];
    assert.deepEqual(alert.categories, ['ai']);
    assert.equal(alert.trader.address, ALICE);
    assert.equal(alert.trade.usd, 50);
    assert.equal(alert.links.market, 'https://polymarket.com/event/ai-bar');
    assert.deepEqual(alert.delivery, { test: true });

    const saved = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(saved.alerts.length, 1);
    assert.equal(saved.traders[ALICE].alertCount, 1);

    nowMs += 5 * 60_000;
    run = await tracker.runCheck();
    assert.equal(run.newAlerts, 0, 'the same trade does not alert again');
    assert.equal(notifier.batches.length, 1);
  });

  test('with BACKFILL_HOURS, the first check also reports recent qualifying trades', async () => {
    await setup({ ai: [ALICE], geopolitics: [] }, { backfillHours: 3 });
    client.trades[ALICE] = [
      tradeRow({ timestamp: T0 - 2 * 3600, key: 'two-hours-ago' }),
      tradeRow({ timestamp: T0 - 4 * 3600, key: 'four-hours-ago' }),
    ];
    let run = await tracker.runCheck();
    assert.equal(run.newAlerts, 1);
    assert.equal(store.state.alerts[0].trade.timestamp, T0 - 2 * 3600);

    // Accounts added later get the same look-back window.
    client.trades[BOB] = [tradeRow({ wallet: BOB, timestamp: T0 - 3600, key: 'bob-hour-ago' })];
    const { trader } = await tracker.addTrader('geopolitics', BOB);
    assert.equal(trader.trackingSince, T0 - 3 * 3600);
    run = await tracker.runCheck();
    assert.equal(run.newAlerts, 1);
  });

  test('passes the minimum amount and look-back floor to the client', async () => {
    await setup();
    await tracker.runCheck();
    assert.deepEqual(client.calls[0], { address: ALICE, options: { minUsd: 30, since: T0 } });
  });

  test('ignores rows that belong to another wallet', async () => {
    await setup();
    client.trades[ALICE] = [tradeRow({ wallet: BOB })];
    const run = await tracker.runCheck();
    assert.equal(run.newAlerts, 0);
  });

  test('an account in two categories produces one alert tagged with both', async () => {
    await setup({ ai: [ALICE], geopolitics: [ALICE] });
    client.trades[ALICE] = [tradeRow()];
    await tracker.runCheck();
    assert.equal(client.calls.length, 1);
    assert.equal(store.state.alerts.length, 1);
    assert.deepEqual(store.state.alerts[0].categories.sort(), ['ai', 'geopolitics']);
  });

  test('a failing account is reported without blocking the others', async () => {
    await setup({ ai: [ALICE, BOB], geopolitics: [] });
    client.failFor.add(ALICE);
    client.trades[BOB] = [tradeRow({ wallet: BOB })];
    const run = await tracker.runCheck();
    assert.equal(run.newAlerts, 1);
    assert.deepEqual(run.errors, [{ address: ALICE, message: 'boom' }]);
    assert.equal(store.state.traders[ALICE].lastError, 'boom');
    assert.equal(store.state.traders[BOB].lastError, null);
  });

  test('loads profile names during checks', async () => {
    await setup();
    client.profiles[ALICE] = { name: 'alice', pseudonym: 'Brave-Owl', verified: true };
    await tracker.runCheck();
    assert.equal(tracker.listTraders()[0].displayName, 'alice');
    assert.equal(tracker.listTraders()[0].verified, true);
  });

  test('addTrader adds by address, by username, and rejects duplicates', async () => {
    await setup();
    client.profiles[BOB] = { name: 'bob', proxyWallet: BOB };
    const added = await tracker.addTrader('geopolitics', BOB.toUpperCase().replace('0X', '0x'), ' Macro guy ');
    assert.equal(added.created, true);
    assert.equal(added.trader.displayName, 'Macro guy');
    assert.equal(added.trader.name, 'bob');
    assert.deepEqual(Object.keys(added.trader.categories), ['geopolitics']);
    assert.equal(added.trader.trackingSince, T0);

    client.searchResults = [{ name: 'alice', proxyWallet: ALICE }];
    const existing = await tracker.addTrader('geopolitics', '@Alice');
    assert.equal(existing.created, false, 'already tracked in AI, now also in Geopolitics');
    assert.deepEqual(Object.keys(existing.trader.categories).sort(), ['ai', 'geopolitics']);
    assert.equal(existing.trader.name, 'alice', 'falls back to the search result when there is no profile');

    await assert.rejects(tracker.addTrader('geopolitics', BOB), (err) => err instanceof UserError && err.status === 409);
    await assert.rejects(tracker.addTrader('geopolitics', '@nobody'), (err) => err instanceof UserError && err.status === 404);
    await assert.rejects(tracker.addTrader('sports', BOB), (err) => err instanceof UserError && err.status === 400);
    await assert.rejects(tracker.addTrader('ai', 'not an address!'), (err) => err instanceof UserError && err.status === 400);
  });

  test('addTrader tracks the Polymarket wallet when given its signer address', async () => {
    await setup({ ai: [], geopolitics: [] });
    const signer = '0x1111111111111111111111111111111111111111';
    client.profiles[signer] = { name: 'carol', proxyWallet: BOB };
    const { trader, warning } = await tracker.addTrader('ai', signer);
    assert.equal(trader.address, BOB);
    assert.match(warning, /Polymarket wallet/);
  });

  test('addTrader warns when an address has no public profile', async () => {
    await setup({ ai: [], geopolitics: [] });
    const { trader, warning } = await tracker.addTrader('ai', BOB);
    assert.equal(trader.address, BOB);
    assert.match(warning, /No public Polymarket profile/);
  });

  test('removeTrader drops one category and forgets the account when none remain', async () => {
    await setup({ ai: [ALICE], geopolitics: [ALICE] });
    let result = await tracker.removeTrader('ai', ALICE);
    assert.deepEqual(result, { removed: true, removedCompletely: false });
    assert.deepEqual(Object.keys(store.state.traders[ALICE].categories), ['geopolitics']);
    result = await tracker.removeTrader('geopolitics', ALICE);
    assert.equal(result.removedCompletely, true);
    assert.equal(store.state.traders[ALICE], undefined);
    await assert.rejects(tracker.removeTrader('ai', ALICE), (err) => err.status === 404);
  });

  test('schedules the next check one interval after the previous one started', async () => {
    await setup();
    tracker.start({ initialDelayMs: 60_000 });
    assert.equal(tracker.status().nextRunAt, nowMs + 60_000);
    const startedAt = nowMs;
    const run = tracker.runCheck('manual');
    assert.equal(tracker.status().running, true);
    nowMs += 2000;
    await run;
    assert.equal(tracker.status().running, false);
    assert.equal(tracker.status().nextRunAt, startedAt + 5 * 60_000);
    assert.equal(tracker.status().lastRun.reason, 'manual');
  });

  test('concurrent check requests share one run', async () => {
    await setup();
    const [a, b] = [tracker.runCheck(), tracker.runCheck()];
    assert.equal(a, b);
    await a;
    assert.equal(client.calls.length, 1);
  });
});
