import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from './tracker.js';

export const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' https: data:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

const MAX_BODY_BYTES = 16 * 1024;
const TRADER_PATH = /^\/api\/traders\/(0x[0-9a-fA-F]{40})(\/refresh)?$/;

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function safeEqual(a, b) {
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function isAuthorized(req, { username, password }) {
  const match = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const userOk = safeEqual(decoded.slice(0, separator), username);
  const passwordOk = safeEqual(decoded.slice(separator + 1), password);
  return userOk && passwordOk;
}

// Stops other websites open in the same browser from driving the API: JSON
// bodies force a CORS preflight (which is never granted), and requests that
// come from a foreign origin are refused outright.
function crossSiteRejection(req) {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return [415, 'Expected a JSON request body.'];
  }
  // Browsers set Sec-Fetch-Site themselves and pages cannot forge it. Trusting
  // it also keeps working behind proxies that rewrite the Host header.
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none' ? null : [403, 'Cross-site request blocked.'];
  // Clients without Fetch Metadata: a declared Origin must match the host.
  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return [403, 'Cross-site request blocked.'];
    }
    const hosts = [req.headers.host, req.headers['x-forwarded-host']]
      .filter(Boolean)
      .flatMap((value) => String(value).split(',').map((host) => host.trim()));
    if (!hosts.includes(originHost)) return [403, 'Cross-site request blocked.'];
  }
  return null;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new UserError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UserError(400, 'Request body is not valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UserError(400, 'Request body must be a JSON object.');
  return body;
}

/**
 * HTTP server for the dashboard: static UI, JSON API and a Server-Sent
 * Events stream (`/api/events`) that pushes tracker updates to open pages.
 */
export function createServer({ tracker, notifier, config, logger = console, publicDir = PUBLIC_DIR }) {
  const streams = new Set();
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) res.write(frame);
  };
  const listeners = {
    status: (status) => broadcast('status', status),
    alerts: (alerts) => broadcast('alerts', alerts),
    traders: () => broadcast('traders', tracker.listTraders()),
    delivery: (updates) => broadcast('delivery', updates),
  };
  for (const [event, listener] of Object.entries(listeners)) tracker.on(event, listener);

  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(': keep-alive\n\n');
  }, 25_000);
  heartbeat.unref();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof UserError) {
        if (!res.headersSent) sendJson(res, err.status, { error: err.message });
        return;
      }
      logger.error(`${req.method} ${req.url} failed: ${err?.stack || err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
      else res.end();
    });
  });

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const [event, listener] of Object.entries(listeners)) tracker.off(event, listener);
    for (const res of streams) res.end();
    streams.clear();
  });

  async function handle(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (config.basicAuth && !isAuthorized(req, config.basicAuth)) {
      res.setHeader('www-authenticate', 'Basic realm="Polymarket Trader Tracker", charset="UTF-8"');
      return sendJson(res, 401, { error: 'Authentication required.' });
    }
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  }

  async function handleApi(req, res, url) {
    const { method } = req;
    const { pathname } = url;
    if (method !== 'GET' && method !== 'HEAD') {
      const rejection = crossSiteRejection(req);
      if (rejection) return sendJson(res, rejection[0], { error: rejection[1] });
    }

    if (pathname === '/api/state' && method === 'GET') return sendJson(res, 200, tracker.snapshot());
    if (pathname === '/api/events' && method === 'GET') return openEventStream(req, res);

    if (pathname === '/api/traders' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = await tracker.addTrader(body.category, body.input, body.label);
      return sendJson(res, result.created ? 201 : 200, result);
    }
    const traderMatch = TRADER_PATH.exec(pathname);
    if (traderMatch && !traderMatch[2] && method === 'DELETE') {
      return sendJson(res, 200, await tracker.removeTrader(url.searchParams.get('category'), traderMatch[1]));
    }
    if (traderMatch && traderMatch[2] && method === 'POST') {
      return sendJson(res, 200, await tracker.refreshProfile(traderMatch[1]));
    }

    if (pathname === '/api/check' && method === 'POST') {
      const alreadyRunning = tracker.running;
      tracker.runCheck('manual');
      return sendJson(res, 202, { started: !alreadyRunning, status: tracker.status() });
    }
    if (pathname === '/api/test-notification' && method === 'POST') {
      return sendJson(res, 200, { results: await notifier.sendTest() });
    }
    return sendJson(res, 404, { error: 'Not found.' });
  }

  function openEventStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    res.write(`event: status\ndata: ${JSON.stringify(tracker.status())}\n\n`);
    streams.add(res);
    const drop = () => streams.delete(res);
    req.on('close', drop);
    res.on('error', drop);
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Method not allowed');
    }
    const entry = STATIC_FILES.get(pathname);
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const [file, type] = entry;
    const body = await fs.readFile(path.join(publicDir, file));
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  return server;
}
