// Runs a single check and exits. The GitHub Actions workflow
// (.github/workflows/tracker.yml) calls this every 5 minutes: tracked accounts
// come from traders/*.txt, state is kept between runs in data/state.json, and
// with --site the dashboard is written as a static site for GitHub Pages.
//
//   node src/run-once.js [--site <dir>] [--traders <dir>]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CATEGORIES, categoryName, loadConfig, loadEnvFile } from './config.js';
import { logger as defaultLogger } from './logger.js';
import { Notifier } from './notifier.js';
import { PolymarketClient } from './polymarket.js';
import { buildSite } from './site.js';
import { Store } from './store.js';
import { readTraderLists, TRADERS_DIR } from './traders-file.js';
import { Tracker } from './tracker.js';

export async function runOnce({
  env = process.env,
  siteDir = null,
  tradersDir = TRADERS_DIR,
  logger = defaultLogger,
  fetchImpl,
  now = Date.now,
} = {}) {
  const config = loadConfig(env);
  const { lists, errors } = readTraderLists(tradersDir, CATEGORIES.map((category) => category.id));
  for (const error of errors) logger.warn(`Skipped traders/${error}`);

  const store = new Store({
    file: path.join(config.dataDir, 'state.json'),
    maxAlerts: config.maxAlerts,
    backfillSeconds: Math.round(config.backfillHours * 3600),
    seed: lists,
    logger,
    now,
  });
  await store.load();
  const withFetch = fetchImpl ? { fetchImpl } : {};
  const client = new PolymarketClient({ ...config.polymarket, logger, ...withFetch });
  const notifier = new Notifier(config.notifications, { logger, categoryName, minTradeUsd: config.minTradeUsd, ...withFetch });
  const tracker = new Tracker({ store, client, notifier, config, logger, now });

  const { added, removed } = tracker.syncTraders(lists);
  if (added.length) logger.info(`Started tracking ${added.join(', ')}`);
  if (removed.length) logger.info(`Stopped tracking ${removed.join(', ')}`);

  const run = await tracker.runCheck('scheduled');

  if (siteDir) {
    await buildSite(siteDir, {
      ...tracker.snapshot(),
      generatedAt: now(),
      hosted: {
        serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
        repository: env.GITHUB_REPOSITORY || null,
        branch: env.GITHUB_REF_NAME || null,
        workflow: 'tracker.yml',
      },
    });
    logger.info(`Dashboard written to ${siteDir}`);
  }
  return run;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if ((flag === '--site' || flag === '--traders') && value) {
      options[flag === '--site' ? 'siteDir' : 'tradersDir'] = path.resolve(value);
      i++;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  loadEnvFile(path.resolve('.env'));
  runOnce(parseArgs(process.argv.slice(2)))
    .then((run) => {
      if (!run) process.exitCode = 1;
    })
    .catch((err) => {
      defaultLogger.error(err?.stack || String(err));
      process.exitCode = 1;
    });
}
