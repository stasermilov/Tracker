'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  conditions: $('conditions-summary'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  checkNow: $('check-now'),
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
};

const tabRefs = new Map();
const panels = new Map();
const freshAlertIds = new Set();
let activeTab = null;

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

// ---------- API ----------

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

async function loadState() {
  const state = await api('GET', '/api/state');
  Object.assign(model, {
    categories: state.categories,
    conditions: state.conditions,
    traders: state.traders,
    alerts: state.alerts,
    status: state.status,
    channels: state.channels,
  });
}

// ---------- unread tracking ----------

const seenKey = (id) => `ptt.seen.${id}`;
const seenAt = (id) => Number(storage.get(seenKey(id))) || 0;
const alertsIn = (id) => model.alerts.filter((alert) => alert.categories.includes(id));

function newestAlertTime(id) {
  return alertsIn(id).reduce((max, alert) => Math.max(max, alert.createdAt), 0);
}

function markSeen(id) {
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
        icon: '/favicon.svg',
      });
      return;
    }
    for (const alert of alerts) {
      const d = describeAlert(alert);
      const notification = new Notification(`${d.side} ${d.usd} · ${d.who}`, {
        body: `${d.verb} ${d.outcome} @ ${formatPrice(alert.trade.price)}\n${alert.trade.title ?? ''}`,
        tag: alert.id,
        icon: '/favicon.svg',
      });
      notification.onclick = () => {
        window.focus();
        const category = alert.categories.find((id) => panels.has(id));
        if (category) selectTab(category);
        notification.close();
      };
    }
  } catch {
    // Some platforms (e.g. Android Chrome) only allow notifications from a service worker.
  }
}

// ---------- rendering ----------

function renderHeader() {
  const usd = formatUsd(model.conditions.minTradeUsd).replace(/\.00$/, '');
  const interval = model.status?.intervalMinutes ?? 5;
  els.conditions.textContent = `Polymarket · taker trades over ${usd} · checked every ${interval} min`;
}

function renderStatus() {
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
  els.statusDot.className = `status-dot ${dot}`;
  els.statusText.textContent = text;
  els.statusText.title = title;
  els.checkNow.disabled = !status || status.running || !model.connected;
  els.checkNow.textContent = status?.running ? 'Checking…' : 'Check now';
}

function renderChannels() {
  els.channelList.replaceChildren(...model.channels.map((channel) => h('li', {
    class: `channel${channel.configured ? ' on' : ''}`,
    title: channel.configured ? `${channel.name} notifications are on` : `${channel.name} is off. ${channel.hint} in .env to enable it.`,
  }, channel.name)));
}

function buildTabs() {
  tabRefs.clear();
  els.tabs.replaceChildren(...model.categories.map((category) => {
    const count = h('span', { class: 'tab-count' }, '0');
    const unread = h('span', { class: 'tab-unread', hidden: true });
    const button = h('button', {
      type: 'button',
      role: 'tab',
      class: 'tab',
      id: `tab-${category.id}`,
      'aria-controls': `panel-${category.id}`,
      'aria-selected': 'false',
      tabindex: '-1',
      onclick: () => selectTab(category.id),
      onkeydown: onTabKeydown,
    }, category.name, count, unread);
    tabRefs.set(category.id, { button, count, unread });
    return button;
  }));
}

function onTabKeydown(event) {
  const ids = model.categories.map((category) => category.id);
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
  els.panels.replaceChildren(...model.categories.map((category) => {
    const refs = buildPanel(category);
    panels.set(category.id, refs);
    return refs.root;
  }));
}

function buildPanel(category) {
  const input = h('input', {
    name: 'input',
    type: 'text',
    required: true,
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: '0x… wallet, profile URL or @username',
    'aria-label': `Account to track in ${category.name}`,
  });
  const label = h('input', {
    name: 'label',
    type: 'text',
    maxlength: '60',
    autocomplete: 'off',
    placeholder: 'Label (optional)',
    'aria-label': 'Optional label for this account',
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, `Add to ${category.name}`);
  const formMsg = h('p', { class: 'form-msg', role: 'status' });
  const form = h('form', { class: 'add-form', novalidate: true }, input, label, submit);
  form.addEventListener('submit', (event) => addTrader(event, category, { input, label, submit, formMsg }));
  input.addEventListener('input', () => {
    if (formMsg.classList.contains('error')) {
      formMsg.className = 'form-msg';
      formMsg.textContent = '';
    }
  });

  const refs = {
    traderCount: h('span', { class: 'count' }),
    traderList: h('ul', { class: 'trader-list', 'aria-label': `Accounts tracked in ${category.name}` }),
    tradersEmpty: h('p', { class: 'empty' },
      h('strong', {}, `No accounts in ${category.name} yet`),
      'Add a wallet address, profile link or @username above.'),
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
      h('p', { class: 'card-note' }, `Every account below is checked for new trades on each run.`),
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

  return h('li', { class: 'trader' },
    avatar(trader),
    h('div', { class: 'trader-id' },
      h('div', { class: 'trader-name-row' },
        externalLink(trader.profileUrl, { class: 'trader-name', title: 'Open Polymarket profile' }, trader.displayName),
        trader.verified && h('span', { class: 'verified', title: 'Verified on Polymarket' }, '✓'),
        secondary),
      h('div', { class: 'trader-address' }, h('code', {}, trader.address), copyButton)),
    h('div', { class: 'trader-meta' }, meta),
    h('div', { class: 'trader-actions' }, refreshButton, removeButton));
}

function alertRow(alert) {
  const trade = alert.trade;
  const d = describeAlert(alert);
  const tsMs = trade.timestamp * 1000;
  const failures = Object.entries(alert.delivery ?? {}).filter(([, result]) => result !== true);
  return h('li', { class: `alert${freshAlertIds.has(alert.id) ? ' fresh' : ''}` },
    h('span', { class: `side-badge ${d.side}` }, d.side),
    h('div', { class: 'alert-head' },
      h('span', { class: 'alert-usd' }, d.usd),
      externalLink(alert.links?.profile, { class: 'alert-who', title: alert.trader.address }, d.who),
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
  refs.alertList.replaceChildren(...alerts.slice(0, 200).map(alertRow));
  refs.alertList.hidden = alerts.length === 0;
  refs.alertsEmpty.hidden = alerts.length > 0;
  const usd = formatUsd(model.conditions.minTradeUsd).replace(/\.00$/, '');
  refs.chips.replaceChildren(
    h('span', { class: 'chip', title: "The tracked account's order crossed the spread" }, 'Price taker'),
    h('span', { class: 'chip', title: 'Shares × price' }, `> ${usd}`),
  );
}

function renderBadges() {
  let total = 0;
  for (const category of model.categories) {
    const refs = tabRefs.get(category.id);
    const traders = model.traders.filter((trader) => trader.categories[category.id]).length;
    refs.count.textContent = String(traders);
    refs.count.title = `${plural(traders, 'tracked account')}`;
    const unread = unreadCount(category.id);
    total += unread;
    refs.unread.hidden = unread === 0;
    refs.unread.textContent = unread > 99 ? '99+' : String(unread);
    refs.unread.title = `${plural(unread, 'new qualifying trade')}`;
  }
  document.title = total ? `(${total}) Trader Tracker` : 'Trader Tracker';
}

function renderAllTraders() {
  for (const id of panels.keys()) renderTraders(id);
  renderBadges();
}

function renderAllAlerts() {
  for (const id of panels.keys()) renderAlerts(id);
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
  for (const [categoryId, refs] of tabRefs) {
    const selected = categoryId === id;
    refs.button.setAttribute('aria-selected', String(selected));
    refs.button.tabIndex = selected ? 0 : -1;
    panels.get(categoryId).root.hidden = !selected;
  }
  if (focus) tabRefs.get(id).button.focus();
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  if (!document.hidden) markSeen(id);
  renderBadges();
}

// ---------- actions ----------

function upsertTrader(trader) {
  const index = model.traders.findIndex((item) => item.address === trader.address);
  if (index === -1) model.traders.push(trader);
  else model.traders[index] = trader;
}

async function addTrader(event, category, refs) {
  event.preventDefault();
  const input = refs.input.value.trim();
  if (!input) {
    refs.formMsg.className = 'form-msg error';
    refs.formMsg.textContent = 'Enter a wallet address, profile URL or @username.';
    refs.input.focus();
    return;
  }
  refs.submit.disabled = true;
  refs.formMsg.className = 'form-msg';
  refs.formMsg.textContent = 'Looking up the account on Polymarket…';
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
    refs.formMsg.className = `form-msg ${result.warning ? 'warning' : 'success'}`;
    refs.formMsg.textContent = result.warning
      ? `Added ${name}. ${result.warning}`
      : `Now tracking ${name} in ${category.name}.`;
  } catch (err) {
    refs.formMsg.className = 'form-msg error';
    refs.formMsg.textContent = err.message;
  } finally {
    refs.submit.disabled = false;
  }
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
        new Notification('Test notification', { body: 'Browser alerts are working.', icon: '/favicon.svg', tag: 'ptt-test' });
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

function addAlerts(alerts) {
  const known = new Set(model.alerts.map((alert) => alert.id));
  for (const alert of alerts) {
    if (known.has(alert.id)) continue;
    model.alerts.push(alert);
    freshAlertIds.add(alert.id);
    setTimeout(() => freshAlertIds.delete(alert.id), 4000);
  }
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

function tick() {
  for (const el of document.querySelectorAll('[data-ago]')) {
    el.textContent = `${el.dataset.prefix ?? ''}${timeAgo(Number(el.dataset.ago))}`;
  }
  renderStatus();
}

async function boot() {
  try {
    await loadState();
  } catch (err) {
    els.statusText.textContent = `Could not reach the tracker (${err.message}). Retrying…`;
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
  const ids = model.categories.map((category) => category.id);
  const fromHash = location.hash.slice(1);
  const saved = storage.get('ptt.tab');
  renderEverything();
  selectTab(ids.includes(fromHash) ? fromHash : ids.includes(saved) ? saved : ids[0]);

  els.checkNow.addEventListener('click', checkNow);
  els.browserToggle.addEventListener('click', toggleBrowserAlerts);
  els.testNotify.addEventListener('click', sendTest);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && activeTab) {
      markSeen(activeTab);
      renderBadges();
    }
  });
  window.addEventListener('hashchange', () => selectTab(location.hash.slice(1)));
  connectEvents();
  setInterval(tick, 15_000);
}

boot();
