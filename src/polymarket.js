// Client for Polymarket's public, unauthenticated read APIs.
//
// Trades come from the Data API. The current endpoint is `GET /v2/trades`
// (snake_case params, `{ data, pagination }` envelope); the legacy
// `GET /trades` (camelCase params, plain array) is used as a fallback when v2
// is unavailable. Both only return the *taker* side of each match when
// `taker_only` / `takerOnly` is true, which is how "the trader was the price
// taker" is determined.
//
// Profiles (display names) come from the Gamma API.

export const DEFAULT_DATA_API_URL = 'https://data-api.polymarket.com';
export const DEFAULT_GAMMA_API_URL = 'https://gamma-api.polymarket.com';

const USER_AGENT = 'polymarket-trader-tracker/1.0 (+https://github.com/stasermilov/Tracker)';
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const ADDRESS_IN_TEXT_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
const USERNAME_RE = /^[^\s/?#@]{1,64}$/;
// Statuses that mean "this endpoint/version can't serve the request" rather
// than a transient failure, so the other trades API version is worth trying.
const UNSUPPORTED_STATUSES = new Set([400, 404, 405, 410, 422, 501]);

export class HttpError extends Error {
  constructor(status, message, { url, retryAfterMs } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

export class UnexpectedResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnexpectedResponseError';
  }
}

export function isAddress(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

export function shortAddress(address) {
  return isAddress(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : String(address ?? '');
}

export function profileUrl(address) {
  return `https://polymarket.com/profile/${address}`;
}

export function txUrl(hash) {
  return hash ? `https://polygonscan.com/tx/${hash}` : null;
}

export function marketUrl({ eventSlug, slug } = {}) {
  if (eventSlug && slug && eventSlug !== slug) {
    return `https://polymarket.com/event/${encodeURIComponent(eventSlug)}/${encodeURIComponent(slug)}`;
  }
  if (eventSlug) return `https://polymarket.com/event/${encodeURIComponent(eventSlug)}`;
  if (slug) return `https://polymarket.com/market/${encodeURIComponent(slug)}`;
  return null;
}

/**
 * Interprets what a user typed into the "add trader" box.
 * Accepts a 0x wallet address, any URL containing one (e.g. a polymarket.com
 * profile link), a polymarket.com/@username link, or a bare/@-prefixed username.
 * @returns {{address: string} | {username: string} | {error: string}}
 */
export function parseTraderInput(input) {
  const text = String(input ?? '').trim();
  if (!text) return { error: 'Enter a wallet address, Polymarket profile URL or @username.' };

  const found = ADDRESS_IN_TEXT_RE.exec(text);
  if (found) return { address: found[0].toLowerCase() };
  if (/^0x[0-9a-f]*$/i.test(text)) {
    return { error: 'Wallet addresses are "0x" followed by 40 hexadecimal characters.' };
  }

  let candidate = text;
  if (/polymarket\.com/i.test(text)) {
    try {
      const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
      const match = /^\/(?:@([^/?#]+)|profile\/@?([^/?#]+))\/?$/.exec(url.pathname);
      if (!/(^|\.)polymarket\.com$/i.test(url.hostname) || !match) {
        return { error: 'That Polymarket link does not point to a profile.' };
      }
      candidate = decodeURIComponent(match[1] ?? match[2]);
    } catch {
      return { error: 'That Polymarket link could not be read.' };
    }
  }
  candidate = candidate.replace(/^@/, '');
  if (USERNAME_RE.test(candidate)) return { username: candidate };
  return { error: 'Enter a 0x wallet address, a Polymarket profile URL or an @username.' };
}

function first(raw, ...keys) {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function toEpochSeconds(value) {
  let n = toNumber(value);
  if (!Number.isFinite(n) && typeof value === 'string') n = Date.parse(value) / 1000;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e12) n /= 1000; // milliseconds
  return Math.floor(n);
}

function str(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

/**
 * Converts a trade row from either API version into one shape.
 * Returns null for rows that are missing the fields needed to evaluate them.
 */
export function normalizeTrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const size = toNumber(first(raw, 'size'));
  const price = toNumber(first(raw, 'price'));
  const timestamp = toEpochSeconds(first(raw, 'timestamp', 'match_time', 'matchTime'));
  if (!Number.isFinite(size) || !Number.isFinite(price) || timestamp === null) return null;
  const outcomeIndex = Number(first(raw, 'outcomeIndex', 'outcome_index'));
  const side = str(first(raw, 'side'));
  return {
    wallet: str(first(raw, 'proxyWallet', 'proxy_wallet'))?.toLowerCase() ?? null,
    side: side ? side.toUpperCase() : null,
    asset: str(first(raw, 'asset', 'token_id', 'tokenId', 'asset_id')),
    conditionId: str(first(raw, 'conditionId', 'condition_id')),
    size,
    price,
    // Cash value of the fill. Rounded to USDC precision so float noise
    // (e.g. 50 * 0.6 = 30.000000000000004) can't push a $30.00 trade over $30.
    usd: Math.round(size * price * 1e6) / 1e6,
    timestamp,
    title: str(first(raw, 'title')),
    slug: str(first(raw, 'slug')),
    eventSlug: str(first(raw, 'eventSlug', 'event_slug')),
    icon: str(first(raw, 'icon')),
    outcome: str(first(raw, 'outcome')),
    // 999 is the API's "unknown" sentinel.
    outcomeIndex: Number.isInteger(outcomeIndex) && outcomeIndex !== 999 ? outcomeIndex : null,
    name: str(first(raw, 'name')),
    pseudonym: str(first(raw, 'pseudonym')),
    profileImage: str(first(raw, 'profileImage', 'profile_image')),
    transactionHash: str(first(raw, 'transactionHash', 'transaction_hash')),
  };
}

/**
 * Gives every trade in one API page a stable identity. Rows have no ID of
 * their own, so the key combines the transaction with the fill details; an
 * occurrence suffix keeps genuinely identical rows in the same page distinct.
 */
export function assignTradeKeys(trades) {
  const counts = new Map();
  for (const trade of trades) {
    const base = [
      trade.transactionHash ?? '',
      trade.timestamp,
      trade.asset ?? trade.conditionId ?? '',
      trade.side ?? '',
      trade.size,
      trade.price,
    ].join('|');
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    trade.key = seen === 0 ? base : `${base}#${seen}`;
  }
  return trades;
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const wallet = str(first(raw, 'proxyWallet', 'proxy_wallet'));
  return {
    name: str(first(raw, 'name')),
    pseudonym: str(first(raw, 'pseudonym')),
    profileImage: str(first(raw, 'profileImage', 'profile_image')),
    xUsername: str(first(raw, 'xUsername', 'x_username')),
    verified: Boolean(first(raw, 'verifiedBadge', 'verified_badge', 'verified')),
    proxyWallet: wallet && isAddress(wallet) ? wallet.toLowerCase() : null,
  };
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function summarizeBody(text) {
  const snippet = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return snippet ? `: ${snippet}` : '';
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PolymarketClient {
  #fetch;
  #sleep;
  #logger;
  #mode;
  #active = null;

  /**
   * @param {object} [options]
   * @param {'auto'|'v2'|'v1'} [options.tradesApi] which trades endpoint to use;
   *   'auto' prefers v2 and falls back to the legacy endpoint if v2 is unavailable.
   */
  constructor({
    dataApiUrl = DEFAULT_DATA_API_URL,
    gammaApiUrl = DEFAULT_GAMMA_API_URL,
    tradesApi = 'auto',
    fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    maxAttempts = 3,
    sleep = defaultSleep,
    logger = console,
  } = {}) {
    if (!['auto', 'v2', 'v1'].includes(tradesApi)) throw new Error(`Unknown trades API version: ${tradesApi}`);
    this.dataApiUrl = dataApiUrl.replace(/\/+$/, '');
    this.gammaApiUrl = gammaApiUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxAttempts = maxAttempts;
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
    this.#logger = logger;
    this.#mode = tradesApi;
  }

  /** The trades endpoint version that last answered successfully ('v2' | 'v1' | null). */
  get tradesApiInUse() {
    return this.#active;
  }

  /**
   * Fetches the trader's most recent trades in which they were the taker and
   * the cash value was at least `minUsd`, newest first. Pages are followed
   * while they still contain trades at or after `since` (epoch seconds).
   */
  async getTakerTrades(address, { minUsd = 0, since = 0, pageSize = 100, maxPages = 10 } = {}) {
    if (!isAddress(address)) throw new Error(`Invalid wallet address: ${address}`);
    const user = address.toLowerCase();
    const options = { minUsd, since, pageSize, maxPages };
    let order = [this.#mode];
    if (this.#mode === 'auto') order = this.#active === 'v1' ? ['v1', 'v2'] : ['v2', 'v1'];

    let lastError;
    for (const version of order) {
      try {
        const trades = version === 'v2'
          ? await this.#tradesV2(user, options)
          : await this.#tradesV1(user, options);
        if (this.#active !== version) {
          if (this.#active) this.#logger.warn(`Switched Polymarket trades API from ${this.#active} to ${version}`);
          this.#active = version;
        }
        return trades;
      } catch (err) {
        const unsupported = err instanceof UnexpectedResponseError
          || (err instanceof HttpError && UNSUPPORTED_STATUSES.has(err.status));
        if (this.#mode !== 'auto' || !unsupported) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  async #tradesV2(user, { minUsd, since, pageSize, maxPages }) {
    const pages = [];
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const body = await this.#getJson(this.dataApiUrl, '/v2/trades', {
        user,
        taker_only: 'true',
        limit: pageSize,
        cursor,
        ...(minUsd > 0 ? { filter_type: 'CASH', filter_amount: minUsd } : {}),
      });
      let rows;
      let nextCursor = null;
      if (Array.isArray(body)) {
        rows = body;
      } else if (body && Array.isArray(body.data)) {
        rows = body.data;
        const pagination = body.pagination ?? {};
        const hasMore = pagination.has_more ?? pagination.hasMore;
        nextCursor = hasMore === false ? null : (pagination.next_cursor ?? pagination.nextCursor ?? null);
      } else {
        throw new UnexpectedResponseError('Unexpected response shape from /v2/trades');
      }
      const batch = assignTradeKeys(rows.map(normalizeTrade).filter(Boolean));
      pages.push(batch);
      if (!nextCursor || batch.length === 0 || oldest(batch) < since) break;
      cursor = nextCursor;
    }
    return mergePages(pages);
  }

  async #tradesV1(user, { minUsd, since, pageSize, maxPages }) {
    const pages = [];
    for (let page = 0; page < maxPages; page++) {
      const body = await this.#getJson(this.dataApiUrl, '/trades', {
        user,
        takerOnly: 'true',
        limit: pageSize,
        offset: page * pageSize,
        ...(minUsd > 0 ? { filterType: 'CASH', filterAmount: minUsd } : {}),
      });
      if (!Array.isArray(body)) throw new UnexpectedResponseError('Unexpected response shape from /trades');
      const batch = assignTradeKeys(body.map(normalizeTrade).filter(Boolean));
      pages.push(batch);
      if (body.length < pageSize || batch.length === 0 || oldest(batch) < since) break;
    }
    return mergePages(pages);
  }

  /** Public profile for a wallet, or null when the wallet has no profile. */
  async getProfile(address) {
    if (!isAddress(address)) throw new Error(`Invalid wallet address: ${address}`);
    try {
      const body = await this.#getJson(this.gammaApiUrl, '/public-profile', { address: address.toLowerCase() });
      return normalizeProfile(body);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /** Searches Polymarket profiles by name; only results with a wallet are returned. */
  async searchProfiles(query) {
    const body = await this.#getJson(this.gammaApiUrl, '/public-search', {
      q: query,
      search_profiles: 'true',
      limit_per_type: 10,
    });
    const profiles = Array.isArray(body?.profiles) ? body.profiles : [];
    return profiles.map(normalizeProfile).filter((profile) => profile?.proxyWallet);
  }

  async #getJson(baseUrl, pathname, params = {}) {
    const url = new URL(baseUrl + pathname);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const where = `${url.host}${url.pathname}`;

    for (let attempt = 1; ; attempt++) {
      let response;
      let text;
      try {
        response = await this.#fetch(url, {
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        text = await response.text();
      } catch (err) {
        if (attempt >= this.maxAttempts) {
          throw new Error(`Request to ${where} failed: ${err.cause?.message ?? err.message}`, { cause: err });
        }
        await this.#sleep(backoff(attempt));
        continue;
      }

      if (response.ok) {
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new UnexpectedResponseError(`Invalid JSON from ${where}`);
        }
      }

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      const error = new HttpError(response.status, `${where} responded ${response.status}${summarizeBody(text)}`, {
        url: url.href,
        retryAfterMs,
      });
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxAttempts) throw error;
      await this.#sleep(Math.min(retryAfterMs ?? backoff(attempt), 30_000));
    }
  }
}

function backoff(attempt) {
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

function oldest(trades) {
  return trades.reduce((min, trade) => Math.min(min, trade.timestamp), Infinity);
}

// Offset/cursor pages can overlap when new trades arrive between requests.
function mergePages(pages) {
  const seen = new Set();
  const merged = [];
  for (const trade of pages.flat()) {
    if (seen.has(trade.key)) continue;
    seen.add(trade.key);
    merged.push(trade);
  }
  return merged;
}
