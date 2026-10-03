import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ASSETS = ['app.js', 'styles.css', 'favicon.svg'];

/**
 * Writes the dashboard as a static site: the regular UI plus a data.json
 * snapshot that the page reads instead of the live API.
 */
export async function buildSite(dir, data, { publicDir = PUBLIC_DIR } = {}) {
  await fs.mkdir(dir, { recursive: true });
  for (const asset of ASSETS) await fs.copyFile(path.join(publicDir, asset), path.join(dir, asset));
  const html = await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
  const marker = '<meta charset="utf-8">';
  if (!html.includes(marker)) throw new Error('public/index.html is missing <meta charset="utf-8">');
  await fs.writeFile(
    path.join(dir, 'index.html'),
    html.replace(marker, `${marker}\n  <meta name="tracker-data" content="data.json">`),
  );
  await fs.writeFile(path.join(dir, 'data.json'), JSON.stringify(data));
  // Serve files as-is on GitHub Pages (no Jekyll processing).
  await fs.writeFile(path.join(dir, '.nojekyll'), '');
}
