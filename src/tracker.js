import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CATEGORIES } from './config.js';
import { marketUrl, parseTraderInput, profileUrl, shortAddress, txUrl } from './polymarket.js';
import { newTraderRecord } from './store.js';

const MAX_SEEN_KEYS = 5000;
const PROFILE_REFRESH_MS = 24 * 60 * 60 * 1000;
const PROFILE_RETRY_MS = 30 * 60 * 1000;
const ALERTS_PER_CATEGORY_IN_SNAPSHOT = 200;

/** An error whose message is safe and useful to show in the UI. */
export class UserError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

export function displayName(trader) {
  return trader.label || trader.name || trader.pseudonym || shortAddress(trader.address);
}

export function describeError(err) {
  const message = err?.message || String(err);
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

export function publicTrader(trader) {
  return {
    address: trader.address,
    displayName: displayName(trader),
    label: trader.label,
    name: trader.name,
    pseudonym: trader.pseudonym,
    profileImage: trader.profileImage,
    xUsername: trader.xUsername,
    verified: trader.verified,
    categories: trader.categories,
    trackingSince: trader.trackingSince,
    lastTradeTs: trader.lastTradeTs || null,
    alertCount: trader.alertCount,
    lastCheckedAt: trader.lastCheckedAt,
    lastError: trader.lastError,
    profileUrl: profileUrl(trader.address),
  };
}

/**
 * Decides which of a trader's fetched trades are new qualifying trades.
 *
 * The trades are already taker-only (the API filters them). A trade qualifies
 * when its cash value is strictly greater than `minUsd`. It is new when it
 * happened after tracking started, has not been processed before, and is no
 * older than `graceSeconds` before the newest qualifying trade seen so far.
 * The grace window catches trades the API indexes late without letting old
 * history re-alert once its keys have been pruned from `seen`.
 *
 * Pure: returns the new trades (oldest first) and the trader's next
 * `seen`/`lastTradeTs` values without mutating the trader.
 */
export function selectNewTrades(trader, trades, { minUsd, graceSeconds }) {
  const seen = { ...trader.seen };
  const floor = Math.max(trader.trackingSince ?? 0, (trader.lastTradeTs ?? 0) - graceSeconds);
  const fresh = [];
  for (const trade of trades) {
    if (!(trade.usd > minUsd)) continue;
    if (trade.timestamp < floor) continue;
    if (Object.hasOwn(seen, trade.key)) continue;
    seen[trade.key] = trade.timestamp;
    fresh.push(trade);
  }

  let lastTradeTs = trader.lastTradeTs ?? 0;
  for (const trade of fresh) lastTradeTs = Math.max(lastTradeTs, trade.timestamp);

  const keepFrom = lastTradeTs - graceSeconds;
  let kept = Object.entries(seen).filter(([, timestamp]) => timestamp >= keepFrom);
  if (kept.length > MAX_SEEN_KEYS) kept = kept.sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEN_KEYS);

  fresh.sort((a, b) => a.timestamp - b.timestamp);
  return { fresh, seen: Object.fromEntries(kept), lastTradeTs };
}

export function buildAlert(trader, trade, categories, nowMs) {
  return {
    id: crypto.createHash('sha1').update(`${trader.address}|${trade.key}`).digest('hex').slice(0, 16),
    createdAt: nowMs,
    categories: [...categories],
    trader: { address: trader.address, name: displayName(trader) },
    trade: {
      side: trade.side,
      outcome: trade.outcome,
      outcomeIndex: trade.outcomeIndex,
      size: trade.size,
      price: trade.price,
      usd: trade.usd,
      timestamp: trade.timestamp,
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
      icon: trade.icon,
      conditionId: trade.conditionId,
      asset: trade.asset,
      transactionHash: trade.transactionHash,
    },
    links: {
      market: marketUrl(trade),
      profile: profileUrl(trader.address),
      tx: txUrl(trade.transactionHash),
    },
  };
}

function applyProfile(trader, profile, nowMs) {
  trader.profileFetchedAt = nowMs;
  trader.profileErrorAt = null;
  if (!profile) return;
  trader.name = profile.name ?? trader.name;
  trader.pseudonym = profile.pseudonym ?? trader.pseudonym;
  trader.profileImage = profile.profileImage ?? trader.profileImage;
  trader.xUsername = profile.xUsername ?? trader.xUsername;
  trader.verified = Boolean(profile.verified);
}

function fillNamesFromTrades(trader, trades) {
  const withName = trades.find((trade) => trade.name || trade.pseudonym);
  if (!withName) return;
  trader.name ||= withName.name;
  trader.pseudonym ||= withName.pseudonym;
  trader.profileImage ||= withName.profileImage;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls every tracked trader on a fixed interval, turns new qualifying trades
 * into alerts and hands them to the notifier.
 *
 * Events: 'status' (scheduler state), 'alerts' (new alerts), 'traders'
 * (tracked accounts changed), 'delivery' (notification results).
 */
export class Tracker extends EventEmitter {
  #timer = null;
  #current = null;
  #scheduling = false;
  #aborted = false;
  #nextRunAt = null;
  #runStartedAt = null;
  #lastRun = null;

  constructor({ store, client, notifier, config, logger = console, now = Date.now, sleep = defaultSleep, requestSpacingMs = 250 }) {
    super();
    this.store = store;
    this.client = client;
    this.notifier = notifier;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.sleep = sleep;
    this.requestSpacingMs = requestSpacingMs;
    this.intervalMs = Math.round(config.pollIntervalMinutes * 60_000);
    this.graceSeconds = Math.round(config.lateTradeGraceMinutes * 60);
    this.backfillSeconds = Math.round((config.backfillHours ?? 0) * 3600);
  }

  /** Starts the polling schedule; the first check runs after `initialDelayMs`. */
  start({ initialDelayMs = 2000 } = {}) {
    this.#scheduling = true;
    this.#aborted = false;
    this.#schedule(initialDelayMs);
    this.emit('status', this.status());
  }

  /** Stops the schedule and makes an in-flight check finish after the current trader. */
  stop() {
    this.#scheduling = false;
    this.#aborted = true;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#nextRunAt = null;
  }

  get running() {
    return this.#current !== null;
  }

  /** Waits for an in-flight check, if any (used on shutdown). */
  async idle() {
    await this.#current;
  }

  status() {
    return {
      running: this.#runStartedAt !== null,
      runStartedAt: this.#runStartedAt,
      intervalMinutes: this.config.pollIntervalMinutes,
      nextRunAt: this.#nextRunAt,
      lastRun: this.#lastRun,
      tradesApi: this.client.tradesApiInUse,
    };
  }

  /** Runs a check now, or joins the one already running. */
  runCheck(reason = 'manual') {
    if (this.#current) return this.#current;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#nextRunAt = null;
    const startedAt = this.now();
    this.#current = this.#run(reason, startedAt)
      .catch((err) => {
        this.logger.error(`Check failed: ${err?.stack || err}`);
        return null;
      })
      .finally(() => {
        this.#runStartedAt = null;
        this.#current = null;
        // Keep a steady cadence measured from the start of each check.
        this.#schedule(Math.max(1000, startedAt + this.intervalMs - this.now()));
        this.emit('status', this.status());
      });
    return this.#current;
  }

  #schedule(delayMs) {
    clearTimeout(this.#timer);
    if (!this.#scheduling) return;
    this.#nextRunAt = this.now() + delayMs;
    this.#timer = setTimeout(() => this.runCheck('scheduled'), delayMs);
  }

  async #run(reason, startedAt) {
    this.#runStartedAt = startedAt;
    this.emit('status', this.status());

    const { traders } = this.store.state;
    const minUsd = this.config.minTradeUsd;
    const graceSeconds = this.graceSeconds;
    const addresses = Object.keys(traders);
    const alerts = [];
    const errors = [];
    let checked = 0;

    for (const [index, address] of addresses.entries()) {
      if (this.#aborted) break;
      const trader = traders[address];
      if (!trader) continue;
      try {
        await this.#maybeRefreshProfile(trader);
        const since = Math.max(trader.trackingSince, trader.lastTradeTs - graceSeconds);
        const trades = await this.client.getTakerTrades(address, { minUsd, since });
        const current = traders[address];
        if (!current) continue; // removed while its trades were being fetched
        // Defensive: only ever evaluate rows that belong to this wallet.
        const own = trades.filter((trade) => !trade.wallet || trade.wallet === address);
        fillNamesFromTrades(current, own);
        const { fresh, seen, lastTradeTs } = selectNewTrades(current, own, { minUsd, graceSeconds });
        current.seen = seen;
        current.lastTradeTs = lastTradeTs;
        current.alertCount += fresh.length;
        current.lastCheckedAt = this.now();
        current.lastError = null;
        const categories = Object.keys(current.categories);
        for (const trade of fresh) alerts.push(buildAlert(current, trade, categories, this.now()));
        checked++;
      } catch (err) {
        const message = describeError(err);
        const current = traders[address];
        if (current) {
          current.lastError = message;
          current.lastCheckedAt = this.now();
        }
        errors.push({ address, message });
        this.logger.warn(`Could not check ${address}: ${message}`);
      }
      if (this.requestSpacingMs && index < addresses.length - 1) await this.sleep(this.requestSpacingMs);
    }

    alerts.sort((a, b) => a.trade.timestamp - b.trade.timestamp);
    this.store.addAlerts(alerts);
    try {
      await this.store.save();
    } catch (err) {
      this.logger.error(`Could not save state: ${describeError(err)}`);
    }

    this.#lastRun = {
      reason,
      startedAt,
      finishedAt: null,
      tradersChecked: checked,
      newAlerts: alerts.length,
      errors,
    };
    this.emit('traders');
    if (alerts.length) {
      this.logger.info(`Found ${alerts.length} new qualifying trade${alerts.length === 1 ? '' : 's'}`);
      this.emit('alerts', alerts);
      await this.#deliver(alerts);
    }
    this.#lastRun.finishedAt = this.now();
    this.logger.info(
      `Check finished: ${checked}/${addresses.length} traders checked, ${alerts.length} new alerts, ${errors.length} errors`,
    );
    return this.#lastRun;
  }

  async #deliver(alerts) {
    if (!this.notifier.enabled) return;
    try {
      const results = await this.notifier.notifyAlerts(alerts);
      for (const alert of alerts) alert.delivery = results.get(alert.id) ?? {};
      this.emit('delivery', alerts.map((alert) => ({ id: alert.id, delivery: alert.delivery })));
      await this.store.save();
    } catch (err) {
      this.logger.error(`Sending notifications failed: ${describeError(err)}`);
    }
  }

  async #maybeRefreshProfile(trader) {
    const nowMs = this.now();
    if (trader.profileFetchedAt && nowMs - trader.profileFetchedAt < PROFILE_REFRESH_MS) return;
    if (trader.profileErrorAt && nowMs - trader.profileErrorAt < PROFILE_RETRY_MS) return;
    try {
      const profile = await this.client.getProfile(trader.address);
      const current = this.store.state.traders[trader.address];
      if (current) applyProfile(current, profile, this.now());
    } catch (err) {
      trader.profileErrorAt = nowMs;
      this.logger.warn(`Could not load profile for ${trader.address}: ${describeError(err)}`);
    }
  }

  listTraders() {
    return Object.values(this.store.state.traders).map(publicTrader);
  }

  snapshot() {
    const perCategory = new Map();
    const alerts = this.store.state.alerts.filter((alert) => {
      let include = false;
      for (const category of alert.categories) {
        const count = perCategory.get(category) ?? 0;
        if (count < ALERTS_PER_CATEGORY_IN_SNAPSHOT) {
          perCategory.set(category, count + 1);
          include = true;
        }
      }
      return include;
    });
    return {
      categories: CATEGORIES.map(({ id, name }) => ({ id, name })),
      conditions: { takerOnly: true, minTradeUsd: this.config.minTradeUsd },
      traders: this.listTraders(),
      alerts,
      status: this.status(),
      channels: this.notifier.describeChannels(),
    };
  }

  /**
   * Starts tracking an account in a category. `input` may be a wallet
   * address, a polymarket.com profile URL or a username.
   */
  async addTrader(categoryId, input, label) {
    const category = CATEGORIES.find((item) => item.id === categoryId);
    if (!category) throw new UserError(400, 'Unknown category.');
    const parsed = parseTraderInput(input);
    if (parsed.error) throw new UserError(400, parsed.error);
    if (label !== undefined && label !== null && typeof label !== 'string') throw new UserError(400, 'Label must be text.');
    const cleanLabel = (label ?? '').trim().slice(0, 60);

    let address = parsed.address;
    let searchMatch = null;
    const notes = [];
    if (parsed.username) {
      let matches;
      try {
        matches = await this.client.searchProfiles(parsed.username);
      } catch (err) {
        throw new UserError(
          502,
          `Couldn't reach Polymarket to look up "${parsed.username}" (${describeError(err)}). Paste the 0x wallet address instead.`,
        );
      }
      const wanted = parsed.username.toLowerCase();
      searchMatch = matches.find((profile) => profile.name?.toLowerCase() === wanted)
        ?? matches.find((profile) => profile.pseudonym?.toLowerCase() === wanted)
        ?? null;
      if (!searchMatch) {
        throw new UserError(
          404,
          `No Polymarket account named "${parsed.username}" was found. Paste the 0x wallet address from their profile URL instead.`,
        );
      }
      address = searchMatch.proxyWallet;
    }

    this.#assertNotTracked(address, category);

    let profile;
    if (!this.store.state.traders[address]?.profileFetchedAt) {
      try {
        profile = await this.client.getProfile(address);
        if (profile?.proxyWallet && profile.proxyWallet !== address) {
          notes.push(`Using the account's Polymarket wallet ${profile.proxyWallet} (the address entered was its signer).`);
          address = profile.proxyWallet;
          this.#assertNotTracked(address, category);
        }
        if (profile === null && searchMatch) {
          profile = searchMatch;
        } else if (profile === null) {
          notes.push(
            'No public Polymarket profile was found for this address. Make sure it is the address from the profile URL (polymarket.com/profile/0x…).',
          );
        }
      } catch (err) {
        profile = searchMatch ?? undefined;
        if (!searchMatch) notes.push(`Couldn't load the profile name right now (${describeError(err)}); it will be retried automatically.`);
      }
    }

    // Re-check after the awaits above: the account may have been added meanwhile.
    this.#assertNotTracked(address, category);
    const { traders } = this.store.state;
    const nowMs = this.now();
    let trader = traders[address];
    const created = !trader;
    if (!trader) {
      trader = newTraderRecord(address, nowMs, this.backfillSeconds);
      traders[address] = trader;
    }
    trader.categories[category.id] = { addedAt: nowMs };
    if (cleanLabel) trader.label = cleanLabel;
    if (profile !== undefined) applyProfile(trader, profile, nowMs);

    await this.store.save();
    this.emit('traders');
    this.logger.info(`Now tracking ${displayName(trader)} (${address}) in ${category.name}`);
    return { trader: publicTrader(trader), created, warning: notes.join(' ') || null };
  }

  #assertNotTracked(address, category) {
    const existing = this.store.state.traders[address];
    if (existing?.categories[category.id]) {
      throw new UserError(409, `${displayName(existing)} is already tracked in ${category.name}.`);
    }
  }

  async removeTrader(categoryId, address) {
    const key = String(address ?? '').toLowerCase();
    const { traders } = this.store.state;
    const trader = traders[key];
    if (!trader?.categories[categoryId]) throw new UserError(404, 'That account is not tracked in this category.');
    delete trader.categories[categoryId];
    const removedCompletely = Object.keys(trader.categories).length === 0;
    if (removedCompletely) delete traders[key];
    await this.store.save();
    this.emit('traders');
    this.logger.info(`Stopped tracking ${displayName(trader)} (${key}) in ${categoryId}`);
    return { removed: true, removedCompletely };
  }

  async refreshProfile(address) {
    const key = String(address ?? '').toLowerCase();
    if (!this.store.state.traders[key]) throw new UserError(404, 'That account is not tracked.');
    let profile;
    try {
      profile = await this.client.getProfile(key);
    } catch (err) {
      throw new UserError(502, `Couldn't load the profile from Polymarket (${describeError(err)}).`);
    }
    const trader = this.store.state.traders[key];
    if (!trader) throw new UserError(404, 'That account is not tracked.');
    applyProfile(trader, profile, this.now());
    await this.store.save();
    this.emit('traders');
    return { trader: publicTrader(trader) };
  }
}
