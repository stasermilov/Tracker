import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Folder with one `<category>.txt` list of tracked accounts per dashboard tab. */
export const TRADERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'traders');

const ADDRESS_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

/**
 * Parses a tracked-accounts list: one wallet address (or a link containing one)
 * per line, optionally followed by a space and a label. Blank lines and lines
 * starting with # are ignored.
 * @returns {{entries: {address: string, label: string|null}[], errors: string[]}}
 */
export function parseTraderList(text) {
  const entries = [];
  const errors = [];
  const seen = new Set();
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const match = ADDRESS_RE.exec(line);
    if (!match) {
      errors.push(`line ${index + 1}: no 0x wallet address in "${line.slice(0, 60)}"`);
      return;
    }
    const address = match[0].toLowerCase();
    if (seen.has(address)) return;
    seen.add(address);
    // The label is whatever follows the address token (or the link around it).
    const label = line.slice(match.index + match[0].length).replace(/^\S*/, '').trim();
    entries.push({ address, label: label ? label.slice(0, 60) : null });
  });
  return { entries, errors };
}

/**
 * Reads `<dir>/<category>.txt` for each category id. A missing file is an
 * empty list.
 * @returns {{lists: Record<string, {address: string, label: string|null}[]>, errors: string[]}}
 */
export function readTraderLists(dir, categoryIds) {
  const lists = {};
  const errors = [];
  for (const id of categoryIds) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, `${id}.txt`), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const parsed = parseTraderList(text);
    lists[id] = parsed.entries;
    errors.push(...parsed.errors.map((error) => `${id}.txt ${error}`));
  }
  return { lists, errors };
}
