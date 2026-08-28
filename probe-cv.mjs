/**
 * Adversarial probe for server/api/cv.js.
 *
 * The sandbox forbids listen(2) (EPERM on TCP and on unix sockets), so instead of
 * a real socket we pull the request listener off the server createApp() builds and
 * feed it mock req/res. Everything in index.js still runs: matchRoute, readBody,
 * JSON parsing, the HttpError -> status mapping and sendJson.
 */
import { Readable } from 'node:stream';
import { createApp } from './server/index.js';
import { bus, EVENTS } from './server/bus.js';

const app = createApp({ startSim: false });
const handler = app.server.listeners('request')[0];
if (typeof handler !== 'function') throw new Error('could not find the request listener');

function mockReq(method, path, bodyText) {
  const req = Readable.from(bodyText === undefined ? [] : [Buffer.from(bodyText, 'utf8')]);
  req.method = method;
  req.url = path;
  req.headers = { host: '127.0.0.1:3000', 'content-type': 'application/json' };
  return req;
}

function mockRes() {
  const res = {
    statusCode: 0,
    headersSent: false,
    _headers: {},
    _chunks: [],
    setHeader(k, v) { this._headers[k] = v; },
    getHeader(k) { return this._headers[k]; },
    writeHead(status, headers = {}) {
      if (this.headersSent) throw new Error('writeHead called twice');
      this.statusCode = status;
      Object.assign(this._headers, headers);
      this.headersSent = true;
      return this;
    },
    write(c) { this._chunks.push(c); return true; },
    end(c) { if (c !== undefined) this._chunks.push(c); this.finished = true; return this; },
    on() { return this; },
  };
  return res;
}

async function req(method, path, body) {
  const res = mockRes();
  await handler(mockReq(method, path, body === undefined ? undefined : JSON.stringify(body)), res);
  const text = res._chunks.map((c) => (Buffer.isBuffer(c) ? c.toString('utf8') : c)).join('');
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.statusCode, json };
}

const alerts = [];
const crowds = [];
bus.on(EVENTS.ALERT, (p) => alerts.push(p));
bus.on(EVENTS.CROWD, (p) => crowds.push(p));

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(`  PASS  ${name}`); }
  else { fail += 1; results.push(`  FAIL  ${name}   ->  ${detail}`); }
}

// ── 1. exported-name / integration check ───────────────────────────────────
const cv = await import('./server/api/cv.js');
for (const n of ['crowdStream', 'ingestCrowd', 'crowdAllStops']) {
  check(`cv.js exports ${n} as a function (index.js imports it)`, typeof cv[n] === 'function', typeof cv[n]);
}

// ── 2. GET crowd-stream, no stopId ─────────────────────────────────────────
let r = await req('GET', '/api/v1/cv/crowd-stream');
check('crowd-stream no stopId -> 200', r.status === 200, JSON.stringify(r.json));
check('crowd-stream has the 4 TRD keys top-level',
  r.json.success === true && typeof r.json.currentCount === 'number' &&
  typeof r.json.densityStatus === 'string' && typeof r.json.recommendedAction === 'string',
  JSON.stringify(r.json));
check('crowd-stream defaults to the hottest stop', r.json.stopId === 'ST_01',
  `got ${r.json.stopId} pct=${r.json.occupancyPct}`);

r = await req('GET', '/api/v1/cv/crowd-stream?stopId=ST_05');
check('crowd-stream?stopId=ST_05 -> ST_05', r.status === 200 && r.json.stopId === 'ST_05', JSON.stringify(r.json));
r = await req('GET', '/api/v1/cv/crowd-stream?stopId=%20ST_05%20');
check('crowd-stream trims a padded stopId', r.status === 200 && r.json.stopId === 'ST_05', JSON.stringify(r.json));
r = await req('GET', '/api/v1/cv/crowd-stream?stopId=NOPE');
check('crowd-stream unknown stop -> 404', r.status === 404, `${r.status} ${JSON.stringify(r.json)}`);
r = await req('GET', '/api/v1/cv/crowd-stream?stopId=');
check('crowd-stream empty stopId -> 200 fallback', r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);

// ── 3. GET /cv/stops ───────────────────────────────────────────────────────
r = await req('GET', '/api/v1/cv/stops');
check('cv/stops -> 200 with 10 stops', r.status === 200 && r.json.stops?.length === 10, JSON.stringify(r.json).slice(0, 160));
check('cv/stops sorted desc by occupancyPct',
  r.json.stops.every((s, i) => i === 0 || r.json.stops[i - 1].occupancyPct >= s.occupancyPct),
  r.json.stops.map((s) => s.occupancyPct).join(','));
check('cv/stops hottest === stops[0]', r.json.hottest?.stopId === r.json.stops[0].stopId);
const sumWaiting = r.json.stops.reduce((a, s) => a + s.count, 0);
check('cv/stops summary.totalWaiting correct', r.json.summary.totalWaiting === sumWaiting,
  `${r.json.summary.totalWaiting} vs ${sumWaiting}`);
check('cv/stops summary.overcrowdedCount is 0 at seed', r.json.summary.overcrowdedCount === 0,
  String(r.json.summary.overcrowdedCount));

// ── 4. ingest validation ───────────────────────────────────────────────────
const bad = [
  ['no body at all', undefined, 400],
  ['empty object', {}, 400],
  ['stopId null', { stopId: null, count: 5 }, 400],
  ['stopId number', { stopId: 12, count: 5 }, 400],
  ['stopId blank', { stopId: '   ', count: 5 }, 400],
  ['unknown stopId', { stopId: 'ST_99', count: 5 }, 404],
  ['count missing', { stopId: 'ST_01' }, 400],
  ['count string', { stopId: 'ST_01', count: '7' }, 400],
  ['count float', { stopId: 'ST_01', count: 7.5 }, 400],
  ['count negative', { stopId: 'ST_01', count: -1 }, 400],
  ['count null', { stopId: 'ST_01', count: null }, 400],
  ['count Infinity(->null in JSON)', { stopId: 'ST_01', count: Infinity }, 400],
  ['source blank', { stopId: 'ST_01', count: 5, source: '  ' }, 400],
  ['source number', { stopId: 'ST_01', count: 5, source: 7 }, 400],
  ['frameId object', { stopId: 'ST_01', count: 5, frameId: {} }, 400],
  ['frameId float', { stopId: 'ST_01', count: 5, frameId: 1.5 }, 400],
  ['inferenceMs negative', { stopId: 'ST_01', count: 5, inferenceMs: -3 }, 400],
  ['inferenceMs string', { stopId: 'ST_01', count: 5, inferenceMs: 'fast' }, 400],
  ['groundTruth float', { stopId: 'ST_01', count: 5, groundTruth: 2.2 }, 400],
  ['groundTruth negative', { stopId: 'ST_01', count: 5, groundTruth: -2 }, 400],
];
for (const [name, body, want] of bad) {
  const res = await req('POST', '/api/v1/cv/ingest', body);
  check(`ingest rejects ${name} -> ${want}`, res.status === want, `got ${res.status} ${JSON.stringify(res.json)}`);
}

// ── 5. TRD worked example: ST_01 capacity 22, count 19 ─────────────────────
alerts.length = 0;
r = await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_01', count: 19, source: 'browser-cv', frameId: 'f1', inferenceMs: 12.4 });
check('ingest 19@ST_01 -> 200', r.status === 200, JSON.stringify(r.json));
check('TRD example densityStatus HIGH', r.json.crowd?.densityStatus === 'HIGH', r.json.crowd?.densityStatus);
check('TRD example occupancyPct 86.36', r.json.crowd?.occupancyPct === 86.36, String(r.json.crowd?.occupancyPct));
check('TRD example recommendedAction DISPATCH_EXTRA_BUS',
  r.json.crowd?.recommendedAction === 'DISPATCH_EXTRA_BUS', r.json.crowd?.recommendedAction);
check('crossing sets alerted=true', r.json.alerted === true, String(r.json.alerted));
check('exactly 1 ALERT on the crossing', alerts.length === 1, `${alerts.length}`);
check('ALERT carries routeIds', Array.isArray(alerts[0]?.routeIds) && alerts[0].routeIds.length > 0,
  JSON.stringify(alerts[0]?.routeIds));
check('ALERT recommendedAction agrees with domain mapping',
  alerts[0]?.recommendedAction === r.json.crowd.recommendedAction, `${alerts[0]?.recommendedAction}`);

r = await req('GET', '/api/v1/cv/crowd-stream?stopId=ST_01');
check('crowd-stream reproduces the TRD response verbatim',
  r.json.success === true && r.json.currentCount === 19 &&
  r.json.densityStatus === 'HIGH' && r.json.recommendedAction === 'DISPATCH_EXTRA_BUS',
  JSON.stringify(r.json));

// ── 6. EDGE TRIGGER ────────────────────────────────────────────────────────
alerts.length = 0;
r = await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_01', count: 21 });
check('2nd over-threshold ingest alerted=false', r.json.alerted === false, String(r.json.alerted));
check('no ALERT republished while latched', alerts.length === 0, `${alerts.length} alerts`);
r = await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_01', count: 22 });
check('3rd over-threshold ingest alerted=false', r.json.alerted === false, String(r.json.alerted));

alerts.length = 0;
r = await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_01', count: 5 });
check('drop below clears without alerting', alerts.length === 0 && r.json.alerted === false, `${alerts.length}`);
r = await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_01', count: 20 });
check('re-cross re-alerts exactly once', r.json.alerted === true && alerts.length === 1,
  `alerted=${r.json.alerted} alerts=${alerts.length}`);

await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_01', count: 0 });
alerts.length = 0;
r = await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_04', count: 25 }); // 25/30 = 83.33
check('83.33% does not alert (PRD says >85)', r.json.alerted === false && alerts.length === 0,
  `pct=${r.json.crowd?.occupancyPct} alerted=${r.json.alerted}`);
r = await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_08', count: 12 }); // 12/14 = 85.71
check('85.71% does alert', r.json.alerted === true, `pct=${r.json.crowd?.occupancyPct}`);

// ── 7. CROWD event on every ingest ─────────────────────────────────────────
crowds.length = 0;
await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_02', count: 3 });
check('CROWD published on ingest', crowds.length === 1, `${crowds.length}`);
check('CROWD payload has stop+stops+hottest',
  crowds[0]?.stop?.stopId === 'ST_02' && Array.isArray(crowds[0]?.stops) && crowds[0]?.hottest !== undefined,
  JSON.stringify(Object.keys(crowds[0] ?? {})));

// ── 8. groundTruth accuracy block ──────────────────────────────────────────
r = await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_03', count: 18, groundTruth: 19 });
check('accuracy block present with groundTruth',
  r.json.accuracy?.absError === 1 && r.json.accuracy?.withinTolerance === true, JSON.stringify(r.json.accuracy));
r = await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_03', count: 15, groundTruth: 19 });
check('withinTolerance false at absError 4',
  r.json.accuracy?.absError === 4 && r.json.accuracy?.withinTolerance === false, JSON.stringify(r.json.accuracy));
r = await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_03', count: 15 });
check('no accuracy block without groundTruth', r.json.accuracy === undefined, JSON.stringify(r.json.accuracy));
r = await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_03', count: 0, groundTruth: 0 });
check('groundTruth 0 is honoured, not read as absent', r.json.accuracy?.absError === 0,
  JSON.stringify(r.json.accuracy));

// ── 9. stored observation hygiene ──────────────────────────────────────────
await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_06', count: 4, frameId: 'FRAME_A', inferenceMs: 9 });
await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_06', count: 5 });
const obs = app.store.crowd_observations.get('crowd_ST_06');
check('frameId does not linger from an earlier frame', obs.frameId === undefined, JSON.stringify(obs));
check('inferenceMs does not linger', obs.inferenceMs === undefined, JSON.stringify(obs));
check('source defaults to browser-cv', obs.source === 'browser-cv', obs.source);
await req('POST', '/api/v1/cv/ingest', { stopId: 'ST_07', count: 2, source: 'x'.repeat(500) });
check('source truncated to 64 chars', app.store.crowd_observations.get('crowd_ST_07').source.length === 64,
  `${app.store.crowd_observations.get('crowd_ST_07').source.length}`);

// ── 10. empty-store cases ──────────────────────────────────────────────────
app.store.stops.clear();
r = await req('GET', '/api/v1/cv/crowd-stream');
check('crowd-stream with zero stops -> 404 not 500', r.status === 404, `${r.status} ${JSON.stringify(r.json)}`);
r = await req('GET', '/api/v1/cv/stops');
check('cv/stops with zero stops -> 200 empty', r.status === 200 && r.json.stops.length === 0 && r.json.hottest === null,
  `${r.status} ${JSON.stringify(r.json)}`);

console.log(results.join('\n'));
console.log(`\nTOTAL: ${pass} pass, ${fail} fail`);
app.sim.stop();
app.store.close();
process.exit(fail === 0 ? 0 : 1);
