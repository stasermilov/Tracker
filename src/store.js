import fs from 'node:fs/promises';
import path from 'node:path';
import { CATEGORIES, SEED_TRADERS } from './config.js';

export const STATE_VERSION = 1;

const CATEGORY_IDS = new Set(CATEGORIES.map((category) => category.id));

export function newTraderRecord(address, nowMs) {
  return {
    address,
    label: null,
    name: null,
    pseudonym: null,
    profileImage: null,
    xUsername: null,
    verified: false,
    // categoryId -> { addedAt }
    categories: {},
    // Trades before this moment (epoch seconds) never alert.
    trackingSince: Math.floor(nowMs / 1000),
    // Newest qualifying trade timestamp seen so far (epoch seconds).
    lastTradeTs: 0,
    // tradeKey -> trade timestamp, for qualifying trades already processed.
    seen: {},
    alertCount: 0,
    lastCheckedAt: null,
    lastError: null,
    profileFetchedAt: null,
    profileErrorAt: null,
  };
}

export function createInitialState(nowMs, seed = SEED_TRADERS) {
  const traders = {};
  for (const [category, addresses] of Object.entries(seed)) {
    for (const address of addresses) {
      const key = address.toLowerCase();
      traders[key] ??= newTraderRecord(key, nowMs);
      traders[key].categories[category] = { addedAt: nowMs };
    }
  }
  return { version: STATE_VERSION, createdAt: nowMs, traders, alerts: [] };
}

function sanitizeState(raw, nowMs, logger) {
  const state = {
    version: STATE_VERSION,
    createdAt: Number(raw?.createdAt) || nowMs,
    traders: {},
    alerts: Array.isArray(raw?.alerts) ? raw.alerts.filter((alert) => alert?.id && alert.trade) : [],
  };
  for (const [address, record] of Object.entries(raw?.traders ?? {})) {
    const key = address.toLowerCase();
    const trader = { ...newTraderRecord(key, nowMs), ...record, address: key };
    trader.categories = {};
    for (const [category, info] of Object.entries(record?.categories ?? {})) {
      if (CATEGORY_IDS.has(category)) trader.categories[category] = { addedAt: Number(info?.addedAt) || nowMs };
      else logger.warn(`Ignoring unknown category "${category}" for ${key}`);
    }
    if (!trader.seen || typeof trader.seen !== 'object') trader.seen = {};
    if (Object.keys(trader.categories).length > 0) state.traders[key] = trader;
  }
  return state;
}

export class Store {
  #state = null;
  #writes = Promise.resolve();

  constructor({ file, maxAlerts = 1000, now = Date.now, logger = console, seed = SEED_TRADERS }) {
    this.file = file;
    this.maxAlerts = maxAlerts;
    this.now = now;
    this.logger = logger;
    this.seed = seed;
  }

  get state() {
    if (!this.#state) throw new Error('Store not loaded');
    return this.#state;
  }

  async load() {
    let text;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return this.#startFresh('No saved state found');
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const backup = `${this.file}.corrupt-${this.now()}`;
      await fs.rename(this.file, backup);
      return this.#startFresh(`Saved state was unreadable (${err.message}); moved it to ${backup}`);
    }
    this.#state = sanitizeState(parsed, this.now(), this.logger);
    this.#capAlerts();
    return this.#state;
  }

  async #startFresh(reason) {
    this.#state = createInitialState(this.now(), this.seed);
    const count = Object.keys(this.#state.traders).length;
    this.logger.info(`${reason}; starting with ${count} seeded trader${count === 1 ? '' : 's'}`);
    await this.save();
    return this.#state;
  }

  /** Persists the current state. Writes are serialized and atomic (temp file + rename). */
  save() {
    const run = this.#writes.then(() => this.#write());
    this.#writes = run.catch(() => {});
    return run;
  }

  async #write() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(this.#state, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.file);
  }

  /** Adds alerts, keeping the list newest-trade-first and capped at maxAlerts. */
  addAlerts(alerts) {
    if (!alerts.length) return;
    const list = this.state.alerts;
    const ids = new Set(list.map((alert) => alert.id));
    for (const alert of alerts) {
      if (!ids.has(alert.id)) list.push(alert);
    }
    this.#capAlerts();
  }

  #capAlerts() {
    const list = this.#state.alerts;
    list.sort((a, b) => b.trade.timestamp - a.trade.timestamp || b.createdAt - a.createdAt);
    if (list.length > this.maxAlerts) list.length = this.maxAlerts;
  }
}
