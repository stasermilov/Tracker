import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  HttpError,
  PolymarketClient,
  assignTradeKeys,
  marketUrl,
  normalizeTrade,
  parseTraderInput,
} from '../src/polymarket.js';
import { makeTrade, startMockPolymarket } from './helpers/mock-polymarket.js';

const TRADER = '0x9aeb534c42b58b21673d5e03e9da14fbd15b2729';
const quiet = { info() {}, warn() {}, error() {} };
const noSleep = async () => {};

describe('parseTraderInput', () => {
  test('accepts a wallet address and lowercases it', () => {
    assert.deepEqual(parseTraderInput(' 0x9AEB534C42B58B21673D5E03E9DA14FBD15B2729 '), { address: TRADER });
  });

  test('extracts the address from a profile URL', () => {
    assert.deepEqual(parseTraderInput(`https://polymarket.com/profile/${TRADER}?tab=activity`), { address: TRADER });
  });

  test('accepts usernames and username links', () => {
    assert.deepEqual(parseTraderInput('@Domer'), { username: 'Domer' });
    assert.deepEqual(parseTraderInput('domer'), { username: 'domer' });
    assert.deepEqual(parseTraderInput('https://polymarket.com/@Domer'), { username: 'Domer' });
    assert.deepEqual(parseTraderInput('polymarket.com/profile/@Domer'), { username: 'Domer' });
  });

  test('rejects empty input, malformed addresses and non-profile links', () => {
    assert.ok(parseTraderInput('').error);
    assert.ok(parseTraderInput('0x1234').error);
    assert.ok(parseTraderInput(`0x${'a'.repeat(64)}`).error, 'a transaction hash is not an address');
    assert.ok(parseTraderInput('https://polymarket.com/event/some-market').error);
    assert.ok(parseTraderInput('two words').error);
  });
});

describe('normalizeTrade', () => {
  test('reads the legacy camelCase shape', () => {
    const trade = normalizeTrade({
      proxyWallet: '0xABC',
      side: 'buy',
      asset: '123',
      conditionId: '0xc',
      size: 150,
      price: 0.62,
      timestamp: 1_790_000_000,
      title: 'Market',
      slug: 'market',
      eventSlug: 'event',
      outcome: 'Yes',
      outcomeIndex: 0,
      name: 'alice',
      transactionHash: '0xt',
    });
    assert.equal(trade.wallet, '0xabc');
    assert.equal(trade.side, 'BUY');
    assert.equal(trade.usd, 93);
    assert.equal(trade.eventSlug, 'event');
    assert.equal(trade.transactionHash, '0xt');
  });

  test('reads the v2 snake_case shape with decimal strings', () => {
    const trade = normalizeTrade({
      proxy_wallet: '0xabc',
      side: 'SELL',
      token_id: '123',
      condition_id: '0xc',
      size: '40.5',
      price: '0.8',
      timestamp: 1_790_000_000,
      event_slug: 'event',
      outcome_index: 999,
      transaction_hash: '0xt',
    });
    assert.equal(trade.asset, '123');
    assert.equal(trade.usd, 32.4);
    assert.equal(trade.outcomeIndex, null, '999 means unknown');
    assert.equal(trade.transactionHash, '0xt');
  });

  test('rounds the cash value so float noise cannot cross the threshold', () => {
    assert.equal(normalizeTrade({ size: 50, price: 0.6, timestamp: 1 }).usd, 30);
  });

  test('converts millisecond timestamps to seconds', () => {
    assert.equal(normalizeTrade({ size: 1, price: 1, timestamp: 1_790_000_000_123 }).timestamp, 1_790_000_000);
  });

  test('drops rows that cannot be evaluated', () => {
    assert.equal(normalizeTrade({ price: 0.5, timestamp: 1 }), null);
    assert.equal(normalizeTrade({ size: 1, timestamp: 1 }), null);
    assert.equal(normalizeTrade({ size: 1, price: 0.5 }), null);
    assert.equal(normalizeTrade(null), null);
  });
});

test('assignTradeKeys keeps identical rows in one page distinct', () => {
  const row = { transactionHash: '0xt', timestamp: 1, asset: 'a', side: 'BUY', size: 10, price: 0.5 };
  const [first, second, other] = assignTradeKeys([{ ...row }, { ...row }, { ...row, size: 11 }]);
  assert.notEqual(first.key, second.key);
  assert.ok(second.key.endsWith('#1'));
  assert.notEqual(first.key, other.key);
});

test('marketUrl links to the event, or the market within a multi-market event', () => {
  assert.equal(marketUrl({ eventSlug: 'e', slug: 'e' }), 'https://polymarket.com/event/e');
  assert.equal(marketUrl({ eventSlug: 'e', slug: 'm' }), 'https://polymarket.com/event/e/m');
  assert.equal(marketUrl({ slug: 'm' }), 'https://polymarket.com/market/m');
  assert.equal(marketUrl({}), null);
});

describe('PolymarketClient', () => {
  let mock;
  let client;

  beforeEach(async () => {
    mock = await startMockPolymarket();
    client = new PolymarketClient({ dataApiUrl: mock.url, gammaApiUrl: mock.url, sleep: noSleep, logger: quiet });
  });

  afterEach(() => mock.close());

  test('asks /v2/trades for taker-only trades above the cash threshold', async () => {
    mock.trades = [
      makeTrade({ size: 100, price: 0.5 }),
      makeTrade({ size: 100, price: 0.5, role: 'maker' }),
      makeTrade({ size: 10, price: 0.5 }),
      makeTrade({ size: 100, price: 0.5, user: '0x1111111111111111111111111111111111111111' }),
    ];
    const trades = await client.getTakerTrades(TRADER, { minUsd: 30 });
    assert.equal(trades.length, 1);
    assert.equal(trades[0].usd, 50);
    const { path, query } = mock.requests.at(-1);
    assert.equal(path, '/v2/trades');
    assert.equal(query.user, TRADER);
    assert.equal(query.taker_only, 'true');
    assert.equal(query.filter_type, 'CASH');
    assert.equal(query.filter_amount, '30');
    assert.equal(client.tradesApiInUse, 'v2');
  });

  test('falls back to the legacy /trades endpoint and stays on it', async () => {
    mock.v2 = false;
    mock.trades = [makeTrade({ size: 100, price: 0.5 }), makeTrade({ size: 100, price: 0.5, role: 'maker' })];
    const trades = await client.getTakerTrades(TRADER, { minUsd: 30 });
    assert.equal(trades.length, 1);
    const legacy = mock.requests.at(-1);
    assert.equal(legacy.path, '/trades');
    assert.equal(legacy.query.takerOnly, 'true');
    assert.equal(legacy.query.filterType, 'CASH');
    assert.equal(legacy.query.filterAmount, '30');
    assert.equal(client.tradesApiInUse, 'v1');

    const before = mock.requests.length;
    await client.getTakerTrades(TRADER, { minUsd: 30 });
    assert.deepEqual(mock.requests.slice(before).map((request) => request.path), ['/trades']);
  });

  test('does not fall back when the API version is pinned', async () => {
    mock.v2 = false;
    const pinned = new PolymarketClient({ dataApiUrl: mock.url, tradesApi: 'v2', sleep: noSleep, logger: quiet });
    await assert.rejects(pinned.getTakerTrades(TRADER), (err) => err instanceof HttpError && err.status === 404);
  });

  for (const version of ['v2', 'v1']) {
    test(`${version}: follows pages until they reach \`since\``, async () => {
      mock.trades = Array.from({ length: 250 }, (_, i) => makeTrade({ timestamp: 2_000_000_000 - i }));
      const pinned = new PolymarketClient({ dataApiUrl: mock.url, tradesApi: version, sleep: noSleep, logger: quiet });
      const trades = await pinned.getTakerTrades(TRADER, { since: 2_000_000_000 - 150, pageSize: 100 });
      assert.equal(trades.length, 200);
      assert.equal(mock.requests.length, 2);
      assert.equal(new Set(trades.map((trade) => trade.key)).size, 200);
    });
  }

  test('fetches a single page when it already covers `since`', async () => {
    mock.trades = Array.from({ length: 150 }, (_, i) => makeTrade({ timestamp: 2_000_000_000 - i }));
    const trades = await client.getTakerTrades(TRADER, { since: 2_000_000_000 - 10, pageSize: 100 });
    assert.equal(trades.length, 100);
    assert.equal(mock.requests.length, 1);
  });

  test('retries rate limits and server errors', async () => {
    mock.trades = [makeTrade()];
    mock.failures = [429, 503];
    const trades = await client.getTakerTrades(TRADER);
    assert.equal(trades.length, 1);
    assert.equal(mock.requests.length, 3);
  });

  test('gives up after repeated server errors without switching endpoints', async () => {
    mock.failures = [500, 500, 500];
    await assert.rejects(client.getTakerTrades(TRADER), (err) => err instanceof HttpError && err.status === 500);
    assert.ok(mock.requests.every((request) => request.path === '/v2/trades'));
  });

  test('loads public profiles and returns null for unknown wallets', async () => {
    mock.profiles[TRADER] = {
      name: 'alice',
      pseudonym: 'Brave-Owl',
      proxyWallet: TRADER,
      profileImage: 'https://example.com/a.png',
      xUsername: 'alice_x',
      verifiedBadge: true,
    };
    const profile = await client.getProfile(TRADER);
    assert.deepEqual(profile, {
      name: 'alice',
      pseudonym: 'Brave-Owl',
      profileImage: 'https://example.com/a.png',
      xUsername: 'alice_x',
      verified: true,
      proxyWallet: TRADER,
    });
    assert.equal(await client.getProfile('0x1111111111111111111111111111111111111111'), null);
  });

  test('searches profiles by name', async () => {
    mock.searchProfiles = [
      { name: 'alice', pseudonym: 'Brave-Owl', proxyWallet: TRADER },
      { name: 'alicia', pseudonym: 'Calm-Fox', proxyWallet: null },
    ];
    const results = await client.searchProfiles('ali');
    assert.deepEqual(results.map((profile) => profile.proxyWallet), [TRADER]);
    assert.equal(mock.requests.at(-1).query.search_profiles, 'true');
  });
});
