import http from 'node:http';

/**
 * Local stand-in for Polymarket's Data and Gamma APIs, following their
 * documented contracts:
 *  - GET /v2/trades: snake_case params, `{ data, pagination }` envelope, cursor paging
 *  - GET /trades:    legacy camelCase params, plain array, offset paging
 *  - taker-only by default; CASH filter keeps size * price >= amount
 *  - GET /public-profile?address=, GET /public-search?q=&search_profiles=true
 *
 * Trades are given in a canonical form: { user, role: 'taker'|'maker', side,
 * size, price, timestamp, title, slug, eventSlug, outcome, outcomeIndex,
 * asset, conditionId, transactionHash, name, pseudonym }.
 */
export async function startMockPolymarket(options = {}) {
  const mock = {
    v2: options.v2 ?? true,
    v1: options.v1 ?? true,
    trades: options.trades ?? [],
    profiles: options.profiles ?? {},
    searchProfiles: options.searchProfiles ?? [],
    failures: [],
    requests: [],
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const query = Object.fromEntries(url.searchParams);
    mock.requests.push({ path: url.pathname, query });
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (mock.failures.length) {
      const status = mock.failures.shift();
      return send(status, { error: `mock failure ${status}` });
    }

    if (url.pathname === '/v2/trades' || url.pathname === '/trades') {
      const v2 = url.pathname === '/v2/trades';
      if (!(v2 ? mock.v2 : mock.v1)) return send(404, { error: 'Not Found' });
      const takerOnly = (v2 ? query.taker_only : query.takerOnly) !== 'false';
      const filterType = v2 ? query.filter_type : query.filterType;
      const filterAmount = Number(v2 ? query.filter_amount : query.filterAmount);
      const limit = Number(query.limit ?? 100);
      const offset = Number(v2 ? (query.cursor ?? 0) : (query.offset ?? 0));
      const rows = mock.trades
        .filter((trade) => !query.user || trade.user === query.user)
        .filter((trade) => !takerOnly || trade.role === 'taker')
        .filter((trade) => filterType !== 'CASH' || trade.size * trade.price >= filterAmount)
        .sort((a, b) => b.timestamp - a.timestamp);
      const page = rows.slice(offset, offset + limit);
      if (!v2) return send(200, page.map(toV1));
      const hasMore = offset + limit < rows.length;
      return send(200, {
        data: page.map(toV2),
        pagination: { limit, offset, has_more: hasMore, next_cursor: hasMore ? String(offset + limit) : null },
      });
    }

    if (url.pathname === '/public-profile') {
      const profile = mock.profiles[(query.address ?? '').toLowerCase()];
      return profile ? send(200, profile) : send(404, { error: 'profile not found' });
    }

    if (url.pathname === '/public-search') {
      const q = (query.q ?? '').toLowerCase();
      const profiles = query.search_profiles === 'true'
        ? mock.searchProfiles.filter((profile) => profile.name?.toLowerCase().includes(q))
        : [];
      return send(200, { events: [], tags: [], profiles, pagination: { hasMore: false } });
    }

    return send(404, { error: 'Not Found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.url = `http://127.0.0.1:${server.address().port}`;
  mock.close = () => new Promise((resolve) => server.close(resolve));
  return mock;
}

function toV1(trade) {
  return {
    proxyWallet: trade.user,
    side: trade.side,
    asset: trade.asset,
    conditionId: trade.conditionId,
    size: trade.size,
    price: trade.price,
    timestamp: trade.timestamp,
    title: trade.title,
    slug: trade.slug,
    icon: '',
    eventSlug: trade.eventSlug,
    outcome: trade.outcome,
    outcomeIndex: trade.outcomeIndex,
    name: trade.name ?? '',
    pseudonym: trade.pseudonym ?? '',
    bio: '',
    profileImage: '',
    profileImageOptimized: '',
    transactionHash: trade.transactionHash,
  };
}

function toV2(trade) {
  return {
    proxy_wallet: trade.user,
    side: trade.side,
    token_id: trade.asset,
    condition_id: trade.conditionId,
    size: String(trade.size),
    price: String(trade.price),
    timestamp: trade.timestamp,
    title: trade.title,
    slug: trade.slug,
    icon: '',
    event_slug: trade.eventSlug,
    outcome: trade.outcome,
    outcome_index: trade.outcomeIndex,
    name: trade.name ?? '',
    pseudonym: trade.pseudonym ?? '',
    bio: '',
    profile_image: '',
    profile_image_optimized: '',
    transaction_hash: trade.transactionHash,
  };
}

let sequence = 0;

/** Builds a canonical mock trade with sensible defaults. */
export function makeTrade(overrides = {}) {
  sequence += 1;
  const hex = sequence.toString(16).padStart(64, '0');
  return {
    user: '0x9aeb534c42b58b21673d5e03e9da14fbd15b2729',
    role: 'taker',
    side: 'BUY',
    size: 100,
    price: 0.5,
    timestamp: 1_790_000_000 + sequence,
    title: 'Will OpenAI release GPT-6 before 2027?',
    slug: 'will-openai-release-gpt-6-before-2027',
    eventSlug: 'openai-gpt-6-release',
    outcome: 'Yes',
    outcomeIndex: 0,
    asset: `${1000 + sequence}`,
    conditionId: `0x${hex}`,
    transactionHash: `0x${hex}`,
    ...overrides,
  };
}
