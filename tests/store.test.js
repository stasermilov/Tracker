import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { SEED_TRADERS } from '../src/config.js';
import { Store } from '../src/store.js';

const quiet = { info() {}, warn() {}, error() {} };
let dir;
let file;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-store-'));
  file = path.join(dir, 'nested', 'state.json');
});

afterEach(() => fs.rm(dir, { recursive: true, force: true }));

test('first start tracks the accounts from the list files and saves them', async () => {
  const store = new Store({ file, now: () => 1_790_000_000_000, logger: quiet });
  const state = await store.load();
  for (const [category, entries] of Object.entries(SEED_TRADERS)) {
    for (const { address } of entries) {
      assert.ok(state.traders[address]?.categories[category], `${address} in ${category}`);
    }
  }
  const expected = new Set(Object.values(SEED_TRADERS).flat().map((entry) => entry.address));
  assert.equal(Object.keys(state.traders).length, expected.size);
  for (const trader of Object.values(state.traders)) assert.equal(trader.trackingSince, 1_790_000_000);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(Object.keys(saved.traders).length, expected.size);
});

test('BACKFILL_HOURS moves the seeded accounts\' tracking start back', async () => {
  const store = new Store({ file, now: () => 1_790_000_000_000, logger: quiet, backfillSeconds: 24 * 3600 });
  await store.load();
  for (const trader of Object.values(store.state.traders)) {
    assert.equal(trader.trackingSince, 1_790_000_000 - 24 * 3600);
  }
});

test('state survives a restart', async () => {
  const first = new Store({ file, logger: quiet });
  await first.load();
  const [address] = Object.keys(first.state.traders);
  first.state.traders[address].categories.geopolitics = { addedAt: 1 };
  first.state.traders[address].lastTradeTs = 123;
  await first.save();

  const second = new Store({ file, logger: quiet });
  await second.load();
  assert.deepEqual(Object.keys(second.state.traders[address].categories), ['ai', 'geopolitics']);
  assert.equal(second.state.traders[address].lastTradeTs, 123);
});

test('an unreadable state file is moved aside and replaced', async () => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{ not json');
  const store = new Store({ file, now: () => 42, logger: quiet });
  await store.load();
  assert.ok(Object.keys(store.state.traders).length >= 9);
  assert.equal(await fs.readFile(`${file}.corrupt-42`, 'utf8'), '{ not json');
});

test('unknown categories are dropped when loading', async () => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    traders: {
      '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA': { categories: { ai: { addedAt: 5 }, sports: { addedAt: 5 } } },
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': { categories: { sports: { addedAt: 5 } } },
    },
  }));
  const store = new Store({ file, logger: quiet });
  await store.load();
  assert.deepEqual(Object.keys(store.state.traders), ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  assert.deepEqual(Object.keys(store.state.traders['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'].categories), ['ai']);
});

test('alert history is newest-first, de-duplicated and capped', async () => {
  const store = new Store({ file, maxAlerts: 10, logger: quiet, seed: { ai: [] } });
  await store.load();
  const alert = (n) => ({ id: `a${n}`, createdAt: n, categories: ['ai'], trade: { timestamp: n } });
  store.addAlerts(Array.from({ length: 12 }, (_, n) => alert(n)));
  store.addAlerts([alert(11)]);
  assert.equal(store.state.alerts.length, 10);
  assert.equal(store.state.alerts[0].id, 'a11');
  assert.equal(store.state.alerts[9].id, 'a2');
});

test('concurrent saves are written in order', async () => {
  const store = new Store({ file, logger: quiet, seed: { ai: [] } });
  await store.load();
  store.state.marker = 1;
  const first = store.save();
  store.state.marker = 2;
  const second = store.save();
  await Promise.all([first, second]);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).marker, 2);
});
