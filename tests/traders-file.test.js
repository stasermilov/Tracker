import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseTraderList, readTraderLists, TRADERS_DIR } from '../src/traders-file.js';

const A = '0x9aeb534c42b58b21673d5e03e9da14fbd15b2729';
const B = '0x2110ba2a1e18840109482ff4ddc547baeff45850';

test('reads addresses, profile links and labels; skips comments, blanks and duplicates', () => {
  const { entries, errors } = parseTraderList([
    '# comment',
    '',
    `${A.toUpperCase().replace('0X', '0x')}`,
    `https://polymarket.com/profile/${B}?tab=activity  Macro desk`,
    `${A} duplicate`,
    'not an address',
  ].join('\n'));
  assert.deepEqual(entries, [
    { address: A, label: null },
    { address: B, label: 'Macro desk' },
  ]);
  assert.deepEqual(errors, ['line 6: no 0x wallet address in "not an address"']);
});

test('a missing list file is an empty list', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-lists-'));
  await fs.writeFile(path.join(dir, 'ai.txt'), `${A}\n`);
  const { lists, errors } = readTraderLists(dir, ['ai', 'geopolitics']);
  assert.deepEqual(lists, { ai: [{ address: A, label: null }], geopolitics: [] });
  assert.deepEqual(errors, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('the repository lists track the nine requested AI accounts', () => {
  const { lists, errors } = readTraderLists(TRADERS_DIR, ['ai', 'geopolitics']);
  assert.deepEqual(errors, []);
  assert.deepEqual(lists.ai.map((entry) => entry.address), [
    '0x9aeb534c42b58b21673d5e03e9da14fbd15b2729',
    '0x2110ba2a1e18840109482ff4ddc547baeff45850',
    '0xb10047d6a254b2ebb306d7a7d13bf59171ab6461',
    '0x736539924a5602b37a03a54fc12c1cc8f98964da',
    '0xbf93328f8b69273453228a82c913207731822fd7',
    '0x8a4c788f043023b8b28a762216d037e9f148532b',
    '0x564f22744b7941ade18d5e0e4f347c30e3057026',
    '0x28b291aa82da13e1d58993873806c92908d5eb4f',
    '0xb89f5425341719d298dc2f5b9a92374f5fde1c44',
  ]);
  assert.deepEqual(lists.geopolitics, []);
});
