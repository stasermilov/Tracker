'use strict';

// The page runs in two modes. Served by the tracker's own server, it uses the
// live API and event stream. Published as a static site (GitHub Pages), it
// reads the data.json snapshot written by the scheduled GitHub Actions run.
const DATA_URL = document.querySelector('meta[name="tracker-data"]')?.content || null;
const HOSTED = Boolean(DATA_URL);
const HOSTED_POLL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT = { id: 'recent', name: 'Last 24 hours' };

const $ = (id) => document.getElementById(id);
const els = {
  conditions: $('conditions-summary'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  checkNow: $('check-now'),
  runLink: $('run-link'),
  browserToggle: $('browser-toggle'),
  channelList: $('channel-list'),
  testNotify: $('test-notify'),
  tabs: $('tabs'),
  panels: $('panels'),
  toasts: $('toasts'),
};

const model = {
  categories: [],
  conditions: { takerOnly: true, minTradeUsd: 30 },
  traders: [],
  alerts: [],
  status: null,
  channels: [],
  connected: false,
  generatedAt: null,
  hosted: null,
  refreshError: null,
};

const tabRefs = new Map();
const panels = new Map();
const freshAlertIds = new Set();
let activeTab = null;

const views = () => [RECENT, ...model.categories];

// ---------- storage (best effort: may be unavailable in private modes) ----------

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore
    }
  },
};

// ---------- formatting ----------

const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sharesFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

const formatUsd = (value) => usdFormat.format(value);
const formatShares = (value) => sharesFormat.format(value);
const formatDate = (ms) => dateFormat.format(new Date(ms));
const shortAddress = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const minUsdLabel = () => formatUsd(model.conditions.minTradeUsd).replace(/\.00$/, '');

function formatPrice(price) {
  const cents = Math.round(price * 1000) / 10;
  return `${Number.isInteger(cents) ? cents.toFixed(0) : cents.toFixed(1)}¢`;
}

function timeAgo(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function timeUntil(ms) {
  const seconds = Math.round((ms - Date.now()) / 1000);
  if (seconds <= 0) return 'due now';
  if (seconds < 60) return 'in <1 min';
  return `in ${Math.ceil(seconds / 60)} min`;
}

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

// ---------- DOM helpers ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICON_PATHS = {
  copy: 'M9 9V5.5A1.5 1.5 0 0 1 10.5 4h8A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H15M5.5 9h8A1.5 1.5 0 0 1 15 10.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 18.5v-8A1.5 1.5 0 0 1 5.5 9z',
  refresh: 'M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7',
  remove: 'M6 6l12 12M18 6L6 18',
};

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(key, value);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

function externalLink(url, props, ...children) {
  const href = safeUrl(url);
  if (!href) return h('span', { class: props?.class }, ...children);
  return h('a', { ...props, href, target: '_blank', rel: 'noopener noreferrer' }, ...children);
}

function toast(message, kind = 'info', ms = 5000) {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  els.toasts.append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- data ----------

async function api(method, url, body) {
  const options = { method, headers: { accept: 'application/json' } };
  if (method !== 'GET') {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body ?? {});
  }
  const response = await fetch(url, options);
  let data = {};
  try {
    data = await response.json();
  } catch {
    // empty or non-JSON body
  }
  if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status})`);
  return data;
}

async function fetchHostedData() {
  const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadState() {
  const state = HOSTED ? await fetchHostedData() : await api('GET', '/api/state');
  Object.assign(model, {
    categories: state.categories,
    conditions: state.conditions,
    traders: state.traders,
    alerts: state.alerts,
    status: state.status,
    channels: state.channels,
    generatedAt: state.generatedAt ?? null,
    hosted: state.hosted ?? null,
  });
}

function githubUrl(...parts) {
  const hosted = model.hosted;
  if (!hosted?.repository) return null;
  return [hosted.serverUrl || 'https://github.com', hosted.repository, ...parts].join('/');
}

function traderListUrl(categoryId, action = 'edit') {
  const branch = model.hosted?.branch;
  if (!branch) return null;
  return githubUrl(action, branch.split('/').map(encodeURIComponent).join('/'), 'traders', `${categoryId}.txt`);
}

// ---------- unread tracking ----------

const seenKey = (id) => `ptt.seen.${id}`;
const seenAt = (id) => Number(storage.get(seenKey(id))) || 0;
const alertsIn = (id) => model.alerts.filter((alert) => alert.categories.includes(id));

function recentAlerts() {
  const since = Date.now() - DAY_MS;
  return model.alerts.filter((alert) => alert.trade.timestamp * 1000 >= since);
}

function newestAlertTime(id) {
  return alertsIn(id).reduce((max, alert) => Math.max(max, alert.createdAt), 0);
}

function markSeen(id) {
  if (id === RECENT.id) {
    // The 24-hour list shows every category's notifications.
    for (const category of model.categories) markSeen(category.id);
    return;
  }
  const newest = newestAlertTime(id);
  if (newest > seenAt(id)) storage.set(seenKey(id), String(newest));
}

function unreadCount(id) {
  const since = seenAt(id);
  return alertsIn(id).filter((alert) => alert.createdAt > since).length;
}

// ---------- browser notifications ----------

const BROWSER_KEY = 'ptt.browserAlerts';
const browserSupported = () => 'Notification' in window && window.isSecureContext;
const browserActive = () => browserSupported() && Notification.permission === 'granted' && storage.get(BROWSER_KEY) === 'on';

function renderBrowserToggle() {
  const button = els.browserToggle;
  if (!browserSupported()) {
    button.textContent = 'Browser alerts: unavailable';
    button.disabled = true;
    button.title = 'Browser notifications need a secure page (https:// or http://localhost).';
    return;
  }
  const active = browserActive();
  button.textContent = `Browser alerts: ${active ? 'on' : 'off'}`;
  button.setAttribute('aria-pressed', String(active));
  button.title = Notification.permission === 'denied'
    ? 'Notifications are blocked for this site in your browser settings.'
    : 'Show a desktop notification for each qualifying trade while this page is open.';
}

async function toggleBrowserAlerts() {
  if (browserActive()) {
    storage.set(BROWSER_KEY, 'off');
    renderBrowserToggle();
    return;
  }
  if (Notification.permission === 'denied') {
    toast("Notifications are blocked for this site. Allow them in your browser's site settings, then try again.", 'error', 8000);
    return;
  }
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission === 'granted') {
    storage.set(BROWSER_KEY, 'on');
    toast('Browser alerts are on. Keep this page open (it can be in the background) to receive them.', 'success');
  } else {
    toast('Notification permission was not granted.', 'error');
  }
  renderBrowserToggle();
}

function describeAlert(alert) {
  const trade = alert.trade;
  const side = trade.side === 'SELL' ? 'SELL' : 'BUY';
  return {
    side,
    who: alert.trader.name || shortAddress(alert.trader.address),
    verb: side === 'SELL' ? 'sold' : 'bought',
    outcome: trade.outcome || 'shares',
    usd: formatUsd(trade.usd),
  };
}

function notifyBrowser(alerts) {
  if (!browserActive() || alerts.length === 0) return;
  try {
    if (alerts.length > 3) {
      new Notification(`${alerts.length} new qualifying trades`, {
        body: alerts.slice(0, 4).map((alert) => {
          const d = describeAlert(alert);
          return `${d.who} ${d.verb} ${d.outcome} · ${d.usd}`;
        }).join('\n'),
        tag: 'ptt-batch',
        icon: 'favicon.svg',
      });
      return;
    }
    for (const alert of alerts) {
      const d = describeAlert(alert);
      const notification = new Notification(`${d.side} ${d.usd} · ${d.who}`, {
        body: `${d.verb} ${d.outcome} @ ${formatPrice(alert.trade.price)}\n${alert.trade.title ?? ''}`,
        tag: alert.id,
        icon: 'favicon.svg',
      });
      notification.onclick = () => {
        window.focus();
        selectTab(RECENT.id);
        notification.close();
      };
    }
  } catch {
    // Some platforms (e.g. Android Chrome) only allow notifications from a service worker.
  }
}

// ---------- rendering ----------

function renderHeader() {
  const interval = model.status?.intervalMinutes ?? 5;
  els.conditions.textContent = `Polymarket · taker trades over ${minUsdLabel()} · checked every ${interval} min`;
  if (HOSTED) {
    const runs = githubUrl('actions', 'workflows', model.hosted?.workflow || 'tracker.yml');
    els.checkNow.hidden = true;
    els.testNotify.hidden = true;
    els.runLink.hidden = !runs;
    if (runs) els.runLink.href = runs;
  }
}

function renderStatus() {
  if (HOSTED) return renderHostedStatus();
  const status = model.status;
  const lastRun = status?.lastRun;
  let dot = '';
  let text;
  let title = '';
  if (!model.connected && status) {
    dot = 'error';
    text = 'Reconnecting to the tracker…';
  } else if (!status) {
    text = 'Connecting…';
  } else if (status.running) {
    dot = 'running';
    text = 'Checking Polymarket…';
  } else {
    const parts = [lastRun?.finishedAt ? `Checked ${timeAgo(lastRun.finishedAt)}` : 'Not checked yet'];
    if (status.nextRunAt) parts.push(`next ${timeUntil(status.nextRunAt)}`);
    if (lastRun?.errors?.length) {
      dot = 'error';
      parts.push(`${plural(lastRun.errors.length, 'account')} failed`);
      title = lastRun.errors.map((error) => `${error.address}: ${error.message}`).join('\n');
    } else if (lastRun) {
      dot = 'ok';
    }
    text = parts.join(' · ');
  }
  setStatus(dot, text, title);
  els.checkNow.disabled = !status || status.running || !model.connected;
  els.checkNow.textContent = status?.running ? 'Checking…' : 'Check now';
}

function renderHostedStatus() {
  const updated = model.generatedAt;
  const interval = model.status?.intervalMinutes ?? 5;
  const errors = model.status?.lastRun?.errors ?? [];
  if (!updated) return setStatus('', 'Loading…');
  const parts = [`Updated ${timeAgo(updated)}`];
  let dot = 'ok';
  let title = `Data from ${formatDate(updated)}. GitHub Actions checks Polymarket every ${interval} minutes.`;
  if (model.refreshError) {
    dot = 'error';
    parts.push(`refresh failed (${model.refreshError})`);
  } else if (Date.now() - updated > Math.max(30, interval * 4) * 60_000) {
    dot = 'error';
    parts.push('the scheduled check looks paused');
    title = 'Open "Runs on GitHub" to see the latest scheduled runs.';
  } else if (errors.length) {
    dot = 'error';
    parts.push(`${plural(errors.length, 'account')} failed`);
    title = errors.map((error) => `${error.address}: ${error.message}`).join('\n');
  }
  setStatus(dot, parts.join(' · '), title);
}

function setStatus(dot, text, title = '') {
  els.statusDot.className = `status-dot ${dot}`;
  els.statusText.textContent = text;
  els.statusText.title = title;
}

function renderChannels() {
  els.channelList.replaceChildren(...model.channels.map((channel) => {
    let title = `${channel.name} notifications are on`;
    if (!channel.configured) {
      title = HOSTED
        ? `${channel.name} is off. Add it as a repository secret on GitHub (see the README).`
        : `${channel.name} is off. ${channel.hint} in .env to enable it.`;
    }
    return h('li', { class: `channel${channel.configured ? ' on' : ''}`, title }, channel.name);
  }));
}

function buildTabs() {
  tabRefs.clear();
  els.tabs.replaceChildren(...views().map((view) => {
    const count = h('span', { class: 'tab-count' }, '0');
    const unread = h('span', { class: 'tab-unread', hidden: true });
    const button = h('button', {
      type: 'button',
      role: 'tab',
      class: 'tab',
      id: `tab-${view.id}`,
      'aria-controls': `panel-${view.id}`,
      'aria-selected': 'false',
      tabindex: '-1',
      onclick: () => selectTab(view.id),
      onkeydown: onTabKeydown,
    }, view.name, count, unread);
    tabRefs.set(view.id, { button, count, unread });
    return button;
  }));
}

function onTabKeydown(event) {
  const ids = views().map((view) => view.id);
  const index = ids.indexOf(activeTab);
  const next = {
    ArrowRight: ids[(index + 1) % ids.length],
    ArrowLeft: ids[(index - 1 + ids.length) % ids.length],
    Home: ids[0],
    End: ids[ids.length - 1],
  }[event.key];
  if (next) {
    event.preventDefault();
    selectTab(next, { focus: true });
  }
}

function buildPanels() {
  panels.clear();
  const recent = buildRecentPanel();
  panels.set(RECENT.id, recent);
  els.panels.replaceChildren(recent.root, ...model.categories.map((category) => {
    const refs = buildPanel(category);
    panels.set(category.id, refs);
    return refs.root;
  }));
}

function buildRecentPanel() {
  const refs = {
    count: h('span', { class: 'count' }),
    chips: h('div', { class: 'chips' }),
    summary: h('dl', { class: 'summary' }),
    list: h('ol', { class: 'alert-list', 'aria-label': 'Notifications from the last 24 hours' }),
    empty: h('p', { class: 'empty' },
      h('strong', {}, 'No notifications in the last 24 hours'),
      'Qualifying trades by any tracked account will be listed here, newest first.'),
  };
  refs.root = h('section', {
    class: 'panel',
    id: `panel-${RECENT.id}`,
    role: 'tabpanel',
    'aria-labelledby': `tab-${RECENT.id}`,
    hidden: true,
  },
  h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Notifications in the last 24 hours', refs.count), refs.chips),
    refs.summary,
    refs.list,
    refs.empty));
  return refs;
}

function buildPanel(category) {
  const input = h('input', {
    id: `add-input-${category.id}`,
    name: 'input',
    type: 'text',
    required: true,
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: HOSTED ? '0x… wallet or polymarket.com/profile/0x… link' : '0x… wallet, profile URL or @username',
    'aria-label': `Account to track in ${category.name}`,
  });
  const label = h('input', {
    id: `add-label-${category.id}`,
    name: 'label',
    type: 'text',
    maxlength: '60',
    autocomplete: 'off',
    placeholder: 'Label (optional)',
    'aria-label': 'Optional label for this account',
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, `Add to ${category.name}`);
  const formMsg = h('div', { class: 'form-msg', role: 'status' });
  const form = h('form', { class: 'add-form', novalidate: true }, input, label, submit);
  const formRefs = { input, label, submit, formMsg };
  form.addEventListener('submit', (event) => (HOSTED ? addTraderHosted : addTrader)(event, category, formRefs));
  input.addEventListener('input', () => {
    if (formMsg.classList.contains('error')) setFormMsg(formMsg, '', '');
  });

  const note = HOSTED
    ? h('p', { class: 'card-note' },
      'This list comes from ',
      h('code', {}, `traders/${category.id}.txt`),
      ' in the GitHub repository. ',
      externalLink(traderListUrl(category.id), { class: 'text-link' }, 'Edit it on GitHub'),
      ' to add or remove accounts.')
    : h('p', { class: 'card-note' }, 'Every account below is checked for new trades on each run.');

  const refs = {
    traderCount: h('span', { class: 'count' }),
    traderList: h('ul', { class: 'trader-list', 'aria-label': `Accounts tracked in ${category.name}` }),
    tradersEmpty: h('p', { class: 'empty' },
      h('strong', {}, `No accounts in ${category.name} yet`),
      HOSTED ? 'Add a wallet address above.' : 'Add a wallet address, profile link or @username above.'),
    alertCount: h('span', { class: 'count' }),
    alertList: h('ol', { class: 'alert-list', 'aria-label': `Qualifying trades in ${category.name}` }),
    alertsEmpty: h('p', { class: 'empty' },
      h('strong', {}, 'No qualifying trades yet'),
      'New trades that meet the conditions will appear here and trigger notifications.'),
    chips: h('div', { class: 'chips' }),
  };

  refs.root = h('section', {
    class: 'panel',
    id: `panel-${category.id}`,
    role: 'tabpanel',
    'aria-labelledby': `tab-${category.id}`,
    hidden: true,
  },
  h('div', { class: 'panel-grid' },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Tracked accounts', refs.traderCount)),
      note,
      form,
      formMsg,
      refs.traderList,
      refs.tradersEmpty),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Qualifying trades', refs.alertCount), refs.chips),
      refs.alertList,
      refs.alertsEmpty)));
  return refs;
}

function conditionChips() {
  return [
    h('span', { class: 'chip', title: "The tracked account's order crossed the spread" }, 'Price taker'),
    h('span', { class: 'chip', title: 'Shares × price' }, `> ${minUsdLabel()}`),
  ];
}

function avatar(trader) {
  const fallback = () => {
    const hue = parseInt(trader.address.slice(2, 8), 16) % 360;
    const initial = trader.displayName.replace(/^0x/i, '').match(/[\p{L}\p{N}]/u)?.[0] ?? '?';
    const el = h('span', { class: 'avatar avatar-fallback', 'aria-hidden': 'true' }, initial);
    el.style.background = `hsl(${hue} 52% 46%)`;
    return el;
  };
  const src = safeUrl(trader.profileImage);
  if (!src) return fallback();
  const img = h('img', { class: 'avatar', src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', width: 36, height: 36 });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

function agoSpan(ms, prefix, title) {
  return h('span', { title, dataset: { ago: String(ms), prefix } }, `${prefix}${timeAgo(ms)}`);
}

function traderRow(trader, category) {
  const secondary = [];
  if (trader.label && (trader.name || trader.pseudonym)) secondary.push(h('span', { class: 'muted' }, trader.name || trader.pseudonym));
  if (trader.xUsername) {
    const handle = trader.xUsername.replace(/^@/, '');
    secondary.push(externalLink(`https://x.com/${encodeURIComponent(handle)}`, { class: 'muted' }, `@${handle}`));
  }

  const meta = [];
  if (trader.lastError) {
    meta.push(h('span', { class: 'warn', title: trader.lastError }, '⚠ Last check failed'));
  } else if (trader.lastCheckedAt) {
    meta.push(agoSpan(trader.lastCheckedAt, 'Checked ', `Last checked ${formatDate(trader.lastCheckedAt)}`));
  } else {
    meta.push(h('span', {}, 'Waiting for first check'));
  }
  if (trader.lastTradeTs) {
    const ms = trader.lastTradeTs * 1000;
    meta.push(agoSpan(ms, 'Last qualifying trade ', formatDate(ms)));
  }
  meta.push(h('span', {}, plural(trader.alertCount, 'alert')));

  const copyButton = h('button', {
    type: 'button',
    class: 'icon-btn copy-btn',
    title: 'Copy address',
    'aria-label': `Copy address of ${trader.displayName}`,
    onclick: () => copyText(trader.address),
  }, icon('copy'));

  let actions = null;
  if (!HOSTED) {
    const refreshButton = h('button', {
      type: 'button',
      class: 'icon-btn',
      title: 'Reload name from Polymarket',
      'aria-label': `Reload profile of ${trader.displayName}`,
    }, icon('refresh'));
    refreshButton.addEventListener('click', () => refreshProfile(trader, refreshButton));
    const removeButton = h('button', {
      type: 'button',
      class: 'icon-btn danger',
      title: `Stop tracking in ${category.name}`,
      'aria-label': `Stop tracking ${trader.displayName} in ${category.name}`,
    }, icon('remove'));
    removeButton.addEventListener('click', () => removeTrader(trader, category, removeButton));
    actions = h('div', { class: 'trader-actions' }, refreshButton, removeButton);
  }

  return h('li', { class: 'trader' },
    avatar(trader),
    h('div', { class: 'trader-id' },
      h('div', { class: 'trader-name-row' },
        externalLink(trader.profileUrl, { class: 'trader-name', title: 'Open Polymarket profile' }, trader.displayName),
        trader.verified && h('span', { class: 'verified', title: 'Verified on Polymarket' }, '✓'),
        secondary),
      h('div', { class: 'trader-address' }, h('code', {}, trader.address), copyButton)),
    h('div', { class: 'trader-meta' }, meta),
    actions);
}

function alertRow(alert, { showCategories = false } = {}) {
  const trade = alert.trade;
  const d = describeAlert(alert);
  const tsMs = trade.timestamp * 1000;
  const failures = Object.entries(alert.delivery ?? {}).filter(([, result]) => result !== true);
  const categoryNames = showCategories
    ? alert.categories.map((id) => model.categories.find((category) => category.id === id)?.name ?? id)
    : [];
  return h('li', { class: `alert${freshAlertIds.has(alert.id) ? ' fresh' : ''}` },
    h('span', { class: `side-badge ${d.side}` }, d.side),
    h('div', { class: 'alert-head' },
      h('span', { class: 'alert-usd' }, d.usd),
      externalLink(alert.links?.profile, { class: 'alert-who', title: alert.trader.address }, d.who),
      categoryNames.map((name) => h('span', { class: 'tag' }, name)),
      h('time', {
        class: 'alert-time',
        datetime: new Date(tsMs).toISOString(),
        title: formatDate(tsMs),
        dataset: { ago: String(tsMs), prefix: '' },
      }, timeAgo(tsMs))),
    externalLink(alert.links?.market, { class: 'alert-market', title: trade.title ?? '' }, trade.title || 'Unknown market'),
    h('div', { class: 'alert-detail' },
      h('span', {}, d.side === 'SELL' ? 'Sold ' : 'Bought ', h('span', { class: 'outcome' }, d.outcome)),
      h('span', {}, `${formatShares(trade.size)} shares @ ${formatPrice(trade.price)}`),
      h('span', {}, 'price taker'),
      safeUrl(alert.links?.tx) && externalLink(alert.links.tx, {}, 'tx'),
      failures.length > 0 && h('span', {
        class: 'warn',
        title: failures.map(([channel, error]) => `${channel}: ${error}`).join('\n'),
      }, '⚠ notification failed')));
}

function renderTraders(id) {
  const refs = panels.get(id);
  // Newest additions first; equal timestamps keep their saved order.
  const traders = model.traders
    .filter((trader) => trader.categories[id])
    .sort((a, b) => b.categories[id].addedAt - a.categories[id].addedAt);
  const category = model.categories.find((item) => item.id === id);
  refs.traderCount.textContent = String(traders.length);
  refs.traderList.replaceChildren(...traders.map((trader) => traderRow(trader, category)));
  refs.traderList.hidden = traders.length === 0;
  refs.tradersEmpty.hidden = traders.length > 0;
}

function renderAlerts(id) {
  const refs = panels.get(id);
  const alerts = alertsIn(id);
  refs.alertCount.textContent = alerts.length ? String(alerts.length) : '';
  refs.alertList.replaceChildren(...alerts.slice(0, 200).map((alert) => alertRow(alert)));
  refs.alertList.hidden = alerts.length === 0;
  refs.alertsEmpty.hidden = alerts.length > 0;
  refs.chips.replaceChildren(...conditionChips());
}

function renderRecent() {
  const refs = panels.get(RECENT.id);
  if (!refs) return;
  const alerts = recentAlerts();
  const total = alerts.reduce((sum, alert) => sum + alert.trade.usd, 0);
  const accounts = new Set(alerts.map((alert) => alert.trader.address)).size;
  const stat = (value, label) => h('div', { class: 'stat' }, h('dt', {}, label), h('dd', {}, value));
  refs.count.textContent = alerts.length ? String(alerts.length) : '';
  refs.chips.replaceChildren(...conditionChips());
  refs.summary.replaceChildren(
    stat(String(alerts.length), alerts.length === 1 ? 'Notification' : 'Notifications'),
    stat(formatUsd(total), 'Total value'),
    stat(String(accounts), accounts === 1 ? 'Account' : 'Accounts'),
  );
  refs.summary.hidden = alerts.length === 0;
  refs.list.replaceChildren(...alerts.map((alert) => alertRow(alert, { showCategories: true })));
  refs.list.hidden = alerts.length === 0;
  refs.empty.hidden = alerts.length > 0;
}

function renderBadges() {
  let total = 0;
  for (const category of model.categories) {
    const refs = tabRefs.get(category.id);
    const traders = model.traders.filter((trader) => trader.categories[category.id]).length;
    refs.count.textContent = String(traders);
    refs.count.title = plural(traders, 'tracked account');
    const unread = unreadCount(category.id);
    total += unread;
    refs.unread.hidden = unread === 0;
    refs.unread.textContent = unread > 99 ? '99+' : String(unread);
    refs.unread.title = plural(unread, 'new qualifying trade');
  }
  const recent = tabRefs.get(RECENT.id);
  if (recent) {
    const count = recentAlerts().length;
    recent.count.textContent = String(count);
    recent.count.title = `${plural(count, 'notification')} in the last 24 hours`;
  }
  document.title = total ? `(${total}) Trader Tracker` : 'Trader Tracker';
}

function renderAllTraders() {
  for (const category of model.categories) renderTraders(category.id);
  renderBadges();
}

function renderAllAlerts() {
  for (const category of model.categories) renderAlerts(category.id);
  renderRecent();
  renderBadges();
}

function renderEverything() {
  renderHeader();
  renderStatus();
  renderChannels();
  renderBrowserToggle();
  renderAllTraders();
  renderAllAlerts();
}

function selectTab(id, { focus = false } = {}) {
  if (!panels.has(id)) return;
  activeTab = id;
  storage.set('ptt.tab', id);
  for (const [viewId, refs] of tabRefs) {
    const selected = viewId === id;
    refs.button.setAttribute('aria-selected', String(selected));
    refs.button.tabIndex = selected ? 0 : -1;
    panels.get(viewId).root.hidden = !selected;
  }
  if (focus) tabRefs.get(id).button.focus();
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  if (!document.hidden) markSeen(id);
  renderBadges();
}

// ---------- actions ----------

function setFormMsg(el, kind, ...content) {
  el.className = `form-msg${kind ? ` ${kind}` : ''}`;
  el.replaceChildren(...content);
}

function upsertTrader(trader) {
  const index = model.traders.findIndex((item) => item.address === trader.address);
  if (index === -1) model.traders.push(trader);
  else model.traders[index] = trader;
}

async function addTrader(event, category, refs) {
  event.preventDefault();
  const input = refs.input.value.trim();
  if (!input) {
    setFormMsg(refs.formMsg, 'error', 'Enter a wallet address, profile URL or @username.');
    refs.input.focus();
    return;
  }
  refs.submit.disabled = true;
  setFormMsg(refs.formMsg, '', 'Looking up the account on Polymarket…');
  try {
    const result = await api('POST', '/api/traders', {
      category: category.id,
      input,
      label: refs.label.value.trim() || undefined,
    });
    upsertTrader(result.trader);
    renderAllTraders();
    refs.input.value = '';
    refs.label.value = '';
    const name = result.trader.displayName;
    setFormMsg(
      refs.formMsg,
      result.warning ? 'warning' : 'success',
      result.warning ? `Added ${name}. ${result.warning}` : `Now tracking ${name} in ${category.name}.`,
    );
  } catch (err) {
    setFormMsg(refs.formMsg, 'error', err.message);
  } finally {
    refs.submit.disabled = false;
  }
}

// On the static site there is no server to save to, so the form prepares the
// line to add to traders/<category>.txt and links to GitHub's editor for it.
function addTraderHosted(event, category, refs) {
  event.preventDefault();
  const match = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/.exec(refs.input.value);
  if (!match) {
    setFormMsg(refs.formMsg, 'error', 'Paste a 0x wallet address or a polymarket.com/profile/0x… link.');
    refs.input.focus();
    return;
  }
  const address = match[0].toLowerCase();
  const existing = model.traders.find((trader) => trader.address === address && trader.categories[category.id]);
  if (existing) {
    setFormMsg(refs.formMsg, 'error', `${existing.displayName} is already tracked in ${category.name}.`);
    return;
  }
  const line = [address, refs.label.value.trim()].filter(Boolean).join(' ');
  const editUrl = traderListUrl(category.id);
  navigator.clipboard?.writeText(line).catch(() => {});
  setFormMsg(refs.formMsg, 'hosted',
    h('span', {}, 'Add this line to ', h('code', {}, `traders/${category.id}.txt`), ' (copied):'),
    h('code', { class: 'line-to-add' }, line),
    h('span', {}, 'On GitHub, paste it on a new line and press ', h('strong', {}, 'Commit changes'),
      '. The account appears here after the next check, within about 5 minutes.'),
    editUrl && externalLink(editUrl, { class: 'btn btn-small' }, `Open ${category.id}.txt on GitHub`));
}

async function removeTrader(trader, category, button) {
  if (!window.confirm(`Stop tracking ${trader.displayName} in ${category.name}?`)) return;
  button.disabled = true;
  try {
    await api('DELETE', `/api/traders/${trader.address}?category=${encodeURIComponent(category.id)}`);
    const current = model.traders.find((item) => item.address === trader.address);
    if (current) {
      const categories = { ...current.categories };
      delete categories[category.id];
      if (Object.keys(categories).length) upsertTrader({ ...current, categories });
      else model.traders = model.traders.filter((item) => item.address !== trader.address);
    }
    renderAllTraders();
    toast(`Stopped tracking ${trader.displayName} in ${category.name}.`, 'success');
  } catch (err) {
    button.disabled = false;
    toast(err.message, 'error');
  }
}

async function refreshProfile(trader, button) {
  button.disabled = true;
  try {
    const result = await api('POST', `/api/traders/${trader.address}/refresh`);
    upsertTrader(result.trader);
    renderAllTraders();
    toast(`Profile reloaded: ${result.trader.displayName}`, 'success', 3000);
  } catch (err) {
    button.disabled = false;
    toast(err.message, 'error');
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; fall back to a temporary textarea.
    const area = h('textarea', { readonly: true, 'aria-hidden': 'true' }, text);
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) {
      toast('Copy failed. Select the address and copy it manually.', 'error');
      return;
    }
  }
  toast('Address copied.', 'success', 2000);
}

async function checkNow() {
  els.checkNow.disabled = true;
  try {
    const result = await api('POST', '/api/check');
    model.status = result.status;
  } catch (err) {
    toast(err.message, 'error');
  }
  renderStatus();
}

async function sendTest() {
  els.testNotify.disabled = true;
  try {
    if (browserActive()) {
      try {
        new Notification('Test notification', { body: 'Browser alerts are working.', icon: 'favicon.svg', tag: 'ptt-test' });
      } catch {
        // see notifyBrowser
      }
    }
    const { results } = await api('POST', '/api/test-notification');
    if (!results.length) {
      toast(
        browserActive()
          ? 'Sent a browser test notification. No push channels (Telegram, Discord, Slack, ntfy, webhook) are configured on the server.'
          : 'No push channels are configured on the server. Add one in .env (see README) or turn on browser alerts.',
        'info',
        9000,
      );
    } else {
      toast(
        results.map((result) => (result.ok ? `${result.name}: sent ✓` : `${result.name}: failed — ${result.error}`)).join('\n'),
        results.every((result) => result.ok) ? 'success' : 'error',
        9000,
      );
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    els.testNotify.disabled = false;
  }
}

// ---------- live updates ----------

function markFresh(alerts) {
  for (const alert of alerts) {
    freshAlertIds.add(alert.id);
    setTimeout(() => freshAlertIds.delete(alert.id), 4000);
  }
}

function addAlerts(alerts) {
  const known = new Set(model.alerts.map((alert) => alert.id));
  const added = alerts.filter((alert) => !known.has(alert.id));
  model.alerts.push(...added);
  markFresh(added);
  model.alerts.sort((a, b) => b.trade.timestamp - a.trade.timestamp || b.createdAt - a.createdAt);
  if (model.alerts.length > 2000) model.alerts.length = 2000;
  if (activeTab && !document.hidden) markSeen(activeTab);
  renderAllAlerts();
}

let everConnected = false;

function connectEvents() {
  const source = new EventSource('/api/events');
  const on = (event, handler) => source.addEventListener(event, (message) => handler(JSON.parse(message.data)));
  source.addEventListener('open', () => {
    model.connected = true;
    if (everConnected) {
      // Resync anything missed while disconnected.
      loadState().then(renderEverything).catch(() => {});
    }
    everConnected = true;
    renderStatus();
  });
  source.addEventListener('error', () => {
    model.connected = false;
    renderStatus();
    if (source.readyState === EventSource.CLOSED) setTimeout(connectEvents, 5000);
  });
  on('status', (status) => {
    model.status = status;
    renderStatus();
  });
  on('traders', (traders) => {
    model.traders = traders;
    renderAllTraders();
  });
  on('alerts', (alerts) => {
    addAlerts(alerts);
    notifyBrowser(alerts);
  });
  on('delivery', (updates) => {
    for (const update of updates) {
      const alert = model.alerts.find((item) => item.id === update.id);
      if (alert) alert.delivery = update.delivery;
    }
    renderAllAlerts();
  });
}

async function pollHosted() {
  const known = new Set(model.alerts.map((alert) => alert.id));
  const before = model.generatedAt;
  try {
    await loadState();
    model.refreshError = null;
  } catch (err) {
    model.refreshError = err.message;
    renderStatus();
    return;
  }
  if (model.generatedAt === before) {
    renderStatus();
    return;
  }
  const added = model.alerts.filter((alert) => !known.has(alert.id));
  markFresh(added);
  if (activeTab && !document.hidden) markSeen(activeTab);
  renderEverything();
  notifyBrowser(added);
}

function tick() {
  for (const el of document.querySelectorAll('[data-ago]')) {
    el.textContent = `${el.dataset.prefix ?? ''}${timeAgo(Number(el.dataset.ago))}`;
  }
  renderStatus();
  // Trades age out of the 24-hour list.
  renderRecent();
  renderBadges();
}

async function boot() {
  try {
    await loadState();
  } catch (err) {
    els.statusText.textContent = `Could not load the tracker data (${err.message}). Retrying…`;
    setTimeout(boot, 5000);
    return;
  }
  model.connected = true;
  buildTabs();
  buildPanels();
  // On the first visit, existing history isn't "unread".
  for (const category of model.categories) {
    if (storage.get(seenKey(category.id)) === null) storage.set(seenKey(category.id), String(newestAlertTime(category.id) || 1));
  }
  const ids = views().map((view) => view.id);
  const fromHash = location.hash.slice(1);
  const saved = storage.get('ptt.tab');
  renderEverything();
  selectTab(ids.includes(fromHash) ? fromHash : ids.includes(saved) ? saved : RECENT.id);

  els.browserToggle.addEventListener('click', toggleBrowserAlerts);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && activeTab) {
      markSeen(activeTab);
      renderBadges();
    }
  });
  window.addEventListener('hashchange', () => selectTab(location.hash.slice(1)));
  if (HOSTED) {
    setInterval(pollHosted, HOSTED_POLL_MS);
  } else {
    els.checkNow.addEventListener('click', checkNow);
    els.testNotify.addEventListener('click', sendTest);
    connectEvents();
  }
  setInterval(tick, 15_000);
}

boot();
