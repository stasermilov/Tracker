import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { runOnce } from '../src/run-once.js';
import { makeTrade, startMockPolymarket } from './helpers/mock-polymarket.js';

const ALICE = '0x9aeb534c42b58b21673d5e03e9da14fbd15b2729';
const BOB = '0x2110ba2a1e18840109482ff4ddc547baeff45850';
const quiet = { info() {}, warn() {}, error() {} };

let dir;
let mock;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-run-once-'));
  await fs.mkdir(path.join(dir, 'traders'));
  await fs.writeFile(path.join(dir, 'traders', 'ai.txt'), `# AI\n${ALICE} Alice\n`);
  await fs.writeFile(path.join(dir, 'traders', 'geopolitics.txt'), '');
  mock = await startMockPolymarket();
});

afterEach(async () => {
  await mock.close();
  await fs.rm(dir, { recursive: true, force: true });
});

function options(extraEnv = {}) {
  return {
    env: {
      DATA_DIR: path.join(dir, 'data'),
      POLYMARKET_DATA_API_URL: mock.url,
      POLYMARKET_GAMMA_API_URL: mock.url,
      BACKFILL_HOURS: '24',
      GITHUB_REPOSITORY: 'stasermilov/Tracker',
      GITHUB_REF_NAME: 'main',
      ...extraEnv,
    },
    siteDir: path.join(dir, 'site'),
    tradersDir: path.join(dir, 'traders'),
    logger: quiet,
  };
}

test('one run tracks the listed accounts, finds the last 24 hours and writes the static dashboard', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  mock.profiles[ALICE] = { name: 'alice', proxyWallet: ALICE };
  mock.trades = [
    makeTrade({ user: ALICE, timestamp: nowSec - 3600, size: 100, price: 0.5 }),
    makeTrade({ user: ALICE, timestamp: nowSec - 2 * 86400, size: 100, price: 0.5 }),
    makeTrade({ user: ALICE, timestamp: nowSec - 600, size: 100, price: 0.5, role: 'maker' }),
  ];

  const run = await runOnce(options());
  assert.equal(run.newAlerts, 1, 'only the taker trade from within the last 24 hours');

  const state = JSON.parse(await fs.readFile(path.join(dir, 'data', 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.traders), [ALICE]);
  assert.equal(state.traders[ALICE].label, 'Alice');

  const html = await fs.readFile(path.join(dir, 'site', 'index.html'), 'utf8');
  assert.match(html, /<meta name="tracker-data" content="data.json">/);
  assert.match(html, /<script src="app.js" defer><\/script>/, 'assets are referenced relatively for project pages');
  for (const asset of ['app.js', 'styles.css', 'favicon.svg', '.nojekyll']) {
    await fs.access(path.join(dir, 'site', asset));
  }
  const data = JSON.parse(await fs.readFile(path.join(dir, 'site', 'data.json'), 'utf8'));
  assert.equal(data.alerts.length, 1);
  assert.equal(data.traders[0].displayName, 'Alice');
  assert.deepEqual(data.hosted, {
    serverUrl: 'https://github.com',
    repository: 'stasermilov/Tracker',
    branch: 'main',
    workflow: 'tracker.yml',
  });
  assert.ok(data.generatedAt > 0);

  // The next scheduled run starts from the saved state: no repeat alerts.
  const again = await runOnce(options());
  assert.equal(again.newAlerts, 0);
});

test('edits to the list files are picked up on the next run', async () => {
  await runOnce(options());
  await fs.writeFile(path.join(dir, 'traders', 'geopolitics.txt'), `${BOB}\n`);
  await fs.writeFile(path.join(dir, 'traders', 'ai.txt'), '');
  await runOnce(options());
  const state = JSON.parse(await fs.readFile(path.join(dir, 'data', 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.traders), [BOB]);
  assert.deepEqual(Object.keys(state.traders[BOB].categories), ['geopolitics']);
});
