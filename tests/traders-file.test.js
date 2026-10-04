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

test('the repository lists track the requested AI and Geopolitics accounts', () => {
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
  assert.deepEqual(lists.geopolitics.map((entry) => entry.address), [
    '0xf2f6af4f27ec2dcf4072095ab804016e14cd5817',
    '0xde7be6d489bce070a959e0cb813128ae659b5f4b',
    '0x9b979a065641e8cfde3022a30ed2d9415cf55e12',
    '0x44c1dfe43260c94ed4f1d00de2e1f80fb113ebc1',
    '0xc6587b11a2209e46dfe3928b31c5514a8e33b784',
    '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
    '0x1cc16713196d456f86fa9c7387dd326a7f73b8df',
    '0xd189664c5308903476f9f079820431e4fd7d06f4',
  ]);
});
