/**
 * CommuteIQ — HTTP server.
 *
 * Zero dependencies: `node:http` for the server, `node:sqlite` for storage,
 * `node:crypto` for pass signing. There is no build step and no install step —
 * `node server/index.js` is the whole thing, and it runs with the network off.
 *
 * Serves the static console from `web/` and the `/api/v1/*` REST surface, with
 * a Server-Sent Events channel at `/api/v1/events` for pushed alerts.
 *
 * ── Handler contract ───────────────────────────────────────────────────────
 * Every handler is `async (ctx) => body | {status, body, headers}` where ctx is:
 *
 *   ctx.req      node IncomingMessage
 *   ctx.res      node ServerResponse (only touch it for streaming responses)
 *   ctx.store    the document store (server/db.js)
 *   ctx.params   path params, e.g. { vehicleId: 'BUS_101' }
 *   ctx.query    URLSearchParams
 *   ctx.body     parsed JSON request body ({} when absent)
 *   ctx.publish  (type, payload) => void — pushes to all SSE clients
 *   ctx.detectors Map<vehicleId, DrowsinessDetector> — per-vehicle EAR debounce
 *   ctx.sim      the scenario driver (server/sim.js)
 *   ctx.resetApp () => void — re-seed the store and rewind the scenario
 *
 * Returning a plain object sends `200 {...body}`. Throwing `HttpError` sends the
 * matching status with `{success:false, error}`. Handlers that write to ctx.res
 * directly must return `undefined`.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from './db.js';
import { seed, assertSeedSanity, PROJECT_ROOT } from './seed.js';
import { EVENTS, publish, sseHub } from './bus.js';
import { createSimulation } from './sim.js';
import { HttpError } from './http-error.js';

import { crowdStream, ingestCrowd, crowdAllStops } from './api/cv.js';
import { reRoute, getFleetState, recallVehicle } from './api/fleet.js';
import { getEta } from './api/eta.js';
import { planJourney } from './api/journey.js';
import { issuePass, verifyPass, listPasses } from './api/pass.js';
import { getTelematics, ingestTelematics, listTelematics } from './api/telematics.js';
import { listRoutes, getRoute, listStops } from './api/routes.js';
import { scenarioState, scenarioControl } from './api/scenario.js';
import { getLiveWeather } from './api/live.js';

export { HttpError };

export const PORT = Number(process.env.PORT ?? 3000);
const WEB_ROOT = join(PROJECT_ROOT, 'web');
const MAX_BODY_BYTES = 256 * 1024;

// ── routing table ──────────────────────────────────────────────────────────
// Patterns support `:name` segments. First match wins.

const ROUTES = [
  // Feature 1 — computer vision crowd analytics
  ['GET',  '/api/v1/cv/crowd-stream',        crowdStream],
  ['GET',  '/api/v1/cv/stops',               crowdAllStops],
  ['POST', '/api/v1/cv/ingest',              ingestCrowd],

  // Feature 2 — predictive ETA
  ['GET',  '/api/v1/eta',                    getEta],

  // Feature 3 — multi-modal planning and universal pass
  ['POST', '/api/v1/journey/plan',           planJourney],
  ['POST', '/api/v1/pass/issue',             issuePass],
  ['POST', '/api/v1/pass/verify',            verifyPass],
  ['GET',  '/api/v1/pass',                   listPasses],

  // Feature 4 — fleet dispatch
  ['GET',  '/api/v1/fleet/state',            getFleetState],
  ['POST', '/api/v1/fleet/re-route',         reRoute],
  ['POST', '/api/v1/fleet/recall',           recallVehicle],

  // Feature 5 — driver telematics
  ['GET',  '/api/v1/telematics',             listTelematics],
  ['GET',  '/api/v1/telematics/:vehicleId',  getTelematics],
  ['POST', '/api/v1/telematics/ingest',      ingestTelematics],

  // Reference data
  ['GET',  '/api/v1/routes',                 listRoutes],
  ['GET',  '/api/v1/routes/:routeId',        getRoute],
  ['GET',  '/api/v1/stops',                  listStops],

  // Demo scenario driver
  ['GET',  '/api/v1/scenario',               scenarioState],
  ['POST', '/api/v1/scenario',               scenarioControl],
  ['GET',  '/api/v1/live/weather',            async () => ({ success: true, weather: await getLiveWeather() })],
];

/** @returns {{handler:Function, params:Record<string,string>}|null} */
function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const [m, pattern, handler] of ROUTES) {
    if (m !== method) continue;
    const pp = pattern.split('/').filter(Boolean);
    if (pp.length !== parts.length) continue;

    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i += 1) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

// ── static files ───────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

async function serveStatic(pathname, res) {
  // Resolve inside WEB_ROOT only — normalize then verify the prefix, so
  // `/../server/index.js` cannot escape the web root.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const target = join(WEB_ROOT, rel === '' || rel.endsWith(sep) ? join(rel, 'index.html') : rel);

  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + sep)) {
    return sendJson(res, 403, { success: false, error: 'forbidden' });
  }

  try {
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': buf.length,
      // The demo must reflect edits instantly and must never serve a stale panel.
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  } catch {
    return sendJson(res, 404, { success: false, error: `not found: ${pathname}` });
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

// ── app ────────────────────────────────────────────────────────────────────

/**
 * Build the app without listening — used by the test suite.
 * @param {{location?:string, startSim?:boolean}} opts
 */
export function createApp({ location = ':memory:', startSim = true } = {}) {
  const store = openDb(location);
  seed(store);
  assertSeedSanity(store);

  const detectors = new Map();
  const sim = createSimulation({ store, publish, detectors });
  if (startSim) sim.start();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;

    // Same-origin by default; permissive CORS keeps a phone on the LAN able to
    // hit /pass/verify when scanning a QR code.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // These are safe for the offline console and prevent common browser-side
    // surprises when the demo is exposed on a LAN for phone scanning.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    try {
      if (pathname === '/api/v1/events') return sseHub.add(req, res);

      if (pathname === '/api/v1/health') {
        return sendJson(res, 200, {
          success: true,
          status: 'ok',
          uptimeSec: Math.round(process.uptime()),
          sseClients: sseHub.clientCount,
          collections: {
            routes: store.routes.size,
            stops: store.stops.size,
            vehicles: store.vehicles.size,
            passes: store.passes.size,
          },
          scenario: sim.state(),
        });
      }

      if (pathname.startsWith('/api/')) {
        const match = matchRoute(req.method, pathname);
        if (!match) throw new HttpError(404, `no route for ${req.method} ${pathname}`);

        const body = await readBody(req);
        const result = await match.handler({
          req, res, store, params: match.params, query: url.searchParams,
          body, publish, detectors, sim, resetApp: reset,
        });

        if (res.headersSent) return undefined; // handler streamed its own response
        if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
          return sendJson(res, result.status, result.body, result.headers ?? {});
        }
        return sendJson(res, 200, result ?? { success: true });
      }

      return serveStatic(pathname, res);
    } catch (err) {
      if (res.headersSent) { try { res.end(); } catch {} return undefined; }
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(`[commuteiq] ${req.method} ${pathname}`, err);
      return sendJson(res, status, {
        success: false,
        error: err.message ?? 'internal error',
        ...(err instanceof HttpError ? err.extra : {}),
      });
    }
  });

  /** Re-seed and restart the scenario. Backs the demo reset control. */
  function reset() {
    seed(store);
    detectors.clear();
    sim.reset();
    publish(EVENTS.RESET, { at: new Date().toISOString() });
  }

  return { server, store, sim, detectors, reset };
}

export function startServer(port = PORT) {
  const app = createApp();
  sseHub.start();
  app.server.listen(port, () => {
    console.log(`\n  CommuteIQ  ▸  http://localhost:${port}`);
    console.log(`  Problem Statement 26205 · SIH 2026`);
    console.log(`  ${app.store.routes.size} routes · ${app.store.stops.size} stops · ${app.store.vehicles.size} vehicles · offline-ready\n`);
  });

  const shutdown = () => {
    console.log('\n  shutting down…');
    app.sim.stop();
    sseHub.stop();
    app.server.close(() => { app.store.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return app;
}

/**
 * Only auto-start when run directly, so tests can import `createApp` cleanly.
 *
 * The comparison goes through `pathToFileURL` rather than interpolating
 * `process.argv[1]` into a `file://` string. `import.meta.url` is a URL, so it
 * percent-encodes anything a path may legally contain and a URL may not — and
 * this project's own directory is "commute sense", with a space. Against a
 * hand-built `file://${process.argv[1]}` that reads `commute sense` on one side
 * and `commute%20sense` on the other, the guard is never true, and
 * `node server/index.js` exits silently having started nothing at all. It is a
 * bug that hides completely on any path without a space in it.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer();
}
