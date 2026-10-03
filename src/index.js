import path from 'node:path';
import { categoryName, loadConfig, loadEnvFile } from './config.js';
import { Notifier } from './notifier.js';
import { PolymarketClient } from './polymarket.js';
import { createServer } from './server.js';
import { Store } from './store.js';
import { Tracker } from './tracker.js';

const logger = {
  info: (message) => console.log(`${new Date().toISOString()} INFO  ${message}`),
  warn: (message) => console.warn(`${new Date().toISOString()} WARN  ${message}`),
  error: (message) => console.error(`${new Date().toISOString()} ERROR ${message}`),
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

async function main() {
  loadEnvFile(path.resolve('.env'));
  const config = loadConfig();

  const store = new Store({
    file: path.join(config.dataDir, 'state.json'),
    maxAlerts: config.maxAlerts,
    backfillSeconds: Math.round(config.backfillHours * 3600),
    logger,
  });
  await store.load();
  const client = new PolymarketClient({ ...config.polymarket, logger });
  const notifier = new Notifier(config.notifications, { logger, categoryName, minTradeUsd: config.minTradeUsd });
  const tracker = new Tracker({ store, client, notifier, config, logger });
  const server = createServer({ tracker, notifier, config, logger });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const { port } = server.address();
  const shownHost = LOOPBACK_HOSTS.has(config.host) || config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const traderCount = Object.keys(store.state.traders).length;
  logger.info(`Dashboard: http://${shownHost}:${port}`);
  logger.info(
    `Tracking ${traderCount} account${traderCount === 1 ? '' : 's'}; checking every ${config.pollIntervalMinutes} min `
      + `for taker trades worth more than $${config.minTradeUsd}`,
  );
  if (config.backfillHours > 0) {
    logger.info(`BACKFILL_HOURS=${config.backfillHours}: newly tracked accounts also report qualifying trades from the past ${config.backfillHours} h`);
  }
  const channels = notifier.describeChannels().filter((channel) => channel.configured).map((channel) => channel.name);
  logger.info(channels.length
    ? `Push notifications: ${channels.join(', ')}`
    : 'No push channels configured (see .env.example); alerts show in the dashboard and as browser notifications');
  if (!LOOPBACK_HOSTS.has(config.host) && !config.basicAuth) {
    logger.warn(`Listening on ${config.host} without a password; set BASIC_AUTH=user:password if other machines can reach it`);
  }

  tracker.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    tracker.stop();
    server.close();
    server.closeAllConnections();
    await Promise.race([tracker.idle(), new Promise((resolve) => setTimeout(resolve, 8000))]);
    await store.save().catch((err) => logger.error(`Could not save state: ${err.message}`));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(err?.stack || String(err));
  process.exit(1);
});
