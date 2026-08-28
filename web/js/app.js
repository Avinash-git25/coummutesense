/**
 * CommuteIQ — console core: state, transport, and the demo's keyboard control.
 *
 * The five panels are deliberately dumb. They render from `state` and they call
 * the API; they never talk to each other. Everything that crosses a panel
 * boundary goes through the event bus here, which mirrors the server's own SSE
 * event names — so the Feature 1 -> Feature 4 hand-off the PRD asks for is one
 * `on('alert')` subscription in fleet.js, not a reference from one panel into
 * another.
 *
 * There is no framework and no build step. `state` is a plain object, panels
 * subscribe to named events, and the DOM is updated by hand. At this size that
 * is less machinery than a reactive layer would cost, and it means the console
 * loads from `file://`-adjacent static hosting with nothing installed.
 */

import { initCv } from './cv.js';
import { initMap } from './map.js';
import { initEta } from './eta.js';
import { initJourney } from './journey.js';
import { initFleet } from './fleet.js';
import { initTelematics } from './telematics.js';

// ── tiny DOM helpers ────────────────────────────────────────────────────────

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Build an element. Attribute names are passed through verbatim, so `data-*`
 * and `aria-*` work without special handling.
 * @param {string} tag
 * @param {Record<string, string|number|boolean|null|undefined>} [attrs]
 * @param {Array<Node|string>|string} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') { node.textContent = String(v); continue; }
    node.setAttribute(k, String(v));
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** Replace a container's children in one shot. */
export function fill(node, children) {
  node.replaceChildren(...(Array.isArray(children) ? children.filter(Boolean) : [children]));
}

export const fmt = {
  /** @param {number} n */ pct: (n) => `${Math.round(Number(n) || 0)}%`,
  /** @param {number} n */ mins: (n) => `${(Math.round(Number(n) * 10) / 10).toFixed(1)}`,
  /** @param {number} n */ km: (n) => `${(Math.round(Number(n) * 10) / 10).toFixed(1)} km`,
  /** @param {number} n */ inr: (n) => `₹${(Math.round(Number(n) * 100) / 100).toFixed(2)}`,
  /** @param {number} n */ int: (n) => String(Math.round(Number(n) || 0)),
  /** @param {string} iso */ clock: (iso) => {
    const d = iso ? new Date(iso) : new Date();
    return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString([], { hour12: false });
  },
};

/** Occupancy band -> the CSS state name the stylesheet keys off. */
export const BAND_COLOR = {
  NOMINAL: 'var(--ok)',
  ELEVATED: 'var(--warn)',
  HIGH: '#ff8a5c',
  CRITICAL: 'var(--crit)',
};

export const MODE_ICON = { walk: '🚶', bus: '🚌', metro: '🚇', erickshaw: '🛺' };

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * Every response body carries `success`, so one place decides what an error is.
 * Rejections carry the server's message, because the operator-facing panels
 * display it verbatim — a dispatch refused by a guard should say *why*.
 */
async function request(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }

  if (!res.ok || body?.success === false) {
    const err = new Error(body?.error ?? `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
};

// ── state ───────────────────────────────────────────────────────────────────

/**
 * The whole console's shared state. Panels read it directly and write only
 * through the reducers below, so there is one place to look when a number on
 * screen disagrees with the server.
 */
export const state = {
  stops: [],                   // reference data, busiest-first
  network: [],                 // hydrated routes with their stops embedded
  routes: [],                  // live per-route operational state
  fleet: null,                 // last /fleet/state or FLEET event
  crowd: new Map(),            // stopId -> stopCrowd view
  telematics: new Map(),       // vehicleId -> telematicsView
  scenario: null,              // beat, index, paused
  alerts: [],                  // newest first, capped
  plan: null,                  // last journey plan
  pass: null,                  // last issued pass
  weather: 'rain',             // shared what-if lever (F2 select drives F3 too)
  focus: {                     // what each panel is currently looking at
    cameraStopId: 'ST_01',
    etaStopId: 'ST_01',
    vehicleId: 'BUS_101',
  },
  connected: false,
};

const MAX_ALERTS = 4;

// ── event bus ───────────────────────────────────────────────────────────────

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

/**
 * Subscribe to an event. Names match the server's EVENTS plus a local `boot`.
 * @param {string} kind
 * @param {(payload:object)=>void} fn
 * @returns {()=>void} unsubscribe
 */
export function on(kind, fn) {
  if (!listeners.has(kind)) listeners.set(kind, new Set());
  listeners.get(kind).add(fn);
  return () => listeners.get(kind)?.delete(fn);
}

/**
 * Dispatch to subscribers. A throwing panel must not stop the others from
 * updating — during a live demo a half-refreshed console beats a frozen one —
 * so handlers are isolated and failures are logged, not propagated.
 */
export function emit(kind, payload = {}) {
  for (const fn of listeners.get(kind) ?? []) {
    try { fn(payload); } catch (err) { console.error(`[commuteiq] ${kind} listener failed`, err); }
  }
}

// ── reducers: the only writers of shared state ──────────────────────────────

/** @param {Array<object>} list stopCrowd views */
export function setCrowd(list) {
  for (const s of list ?? []) state.crowd.set(s.stopId, s);
}

/**
 * Merge, don't replace.
 *
 * `GET /fleet/state` returns more than the pushed FLEET frame does — the
 * re-route history, the per-stop crowd list, the hottest stop. Overwriting
 * `state.fleet` wholesale on every tick would drop those the moment the first
 * event arrived, and the "seats added" KPI would silently fall back to zero
 * seconds after a successful dispatch. Merging keeps the fields only the full
 * fetch carries while the live ones stay current.
 */
export function setFleet(fleet) {
  if (!fleet) return;
  state.fleet = { ...(state.fleet ?? {}), ...fleet };
  if (Array.isArray(fleet.routes)) state.routes = fleet.routes;
}

export function setTelematics(view) {
  if (view?.vehicleId) state.telematics.set(view.vehicleId, view);
}

// ── alert rail ──────────────────────────────────────────────────────────────

const KIND_LABEL = {
  OVERCROWDING: 'Overcrowding',
  DROWSINESS: 'Drowsiness',
  DISPATCH_CONFIRMED: 'Dispatched',
};

/**
 * A single audio context, created on the first alert.
 *
 * Browsers refuse to start audio before a user gesture, and the demo's first
 * alert can fire from the scripted timeline rather than from a click. So a
 * failure here is swallowed: an alert that cannot beep must still be an alert
 * that shows. PRD Feature 5 asks for an audible cue and this delivers it when
 * the browser allows one.
 */
let audioCtx = null;

function beep({ freq = 660, ms = 160, gain = 0.05 } = {}) {
  try {
    audioCtx ??= new (window.AudioContext ?? window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const vol = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    vol.gain.value = gain;
    osc.connect(vol).connect(audioCtx.destination);
    const t0 = audioCtx.currentTime;
    osc.start(t0);
    vol.gain.setValueAtTime(gain, t0);
    vol.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    osc.stop(t0 + ms / 1000);
  } catch { /* no audio available; the visual alert stands on its own */ }
}

function renderAlerts() {
  const rail = $('#alert-rail');
  fill(rail, state.alerts.map((a) => el('div', { class: 'alert', 'data-sev': a.severity ?? 'info' }, [
    el('b', { text: KIND_LABEL[a.kind] ?? a.kind ?? 'Alert' }),
    el('span', { text: a.message ?? describeAlert(a) }),
    // A condition that keeps re-firing is one condition, so it stays one chip and
    // says how many times instead — the information is kept without the rail
    // filling up with four copies of the same stop.
    a._repeats > 1 ? el('span', { class: 'alert-count', text: `×${a._repeats}` }) : null,
    el('span', { class: 'alert-time', text: fmt.clock(a._lastAt ?? a.at) }),
  ])));
}

function describeAlert(a) {
  if (a.kind === 'OVERCROWDING') {
    return `${a.stopName ?? a.stopId} at ${fmt.pct(a.occupancyPct)} of capacity (${a.count}/${a.capacity}) — ${a.recommendedAction}`;
  }
  if (a.kind === 'DROWSINESS') {
    return `${a.driverName ?? a.driverId ?? a.vehicleId}: eyes closed ${Math.round(a.closedMs ?? 0)} ms — pull over`;
  }
  return JSON.stringify(a);
}

/**
 * How long the same condition keeps folding into its existing chip.
 *
 * Two independent things can report the same overcrowding: the scenario driver's
 * own latch in sim.js, and the browser CV detector's ingest crossing the trigger
 * a tick later. Both are legitimate — they are separate sensors — but an operator
 * does not want the same condition announced twice, and neither does a judge.
 *
 * The window has to be sized against how long the *condition* lasts, not how far
 * apart two sensors fire. A platform at 89% of capacity stays at 89% for minutes,
 * and re-announces every time the crowd is re-evaluated. At 4 s that produced
 * "IT Park 89%" twice in the rail 15 s apart, and against MAX_ALERTS = 4 a single
 * unresolved stop could evict the three other stops that needed attention — the
 * loudest problem hiding the rest, which is the opposite of what a triage rail is
 * for. 90 s comfortably outlives a scenario beat, so one condition holds one slot
 * for as long as it persists.
 */
const DEDUPE_MS = 90_000;

function pushAlert(a) {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const key = `${a.kind}|${a.stopId ?? ''}|${a.vehicleId ?? ''}|${a.routeId ?? ''}`;

  // Measured from the last sighting, not the first, so a condition that is still
  // being reported keeps its slot rather than ageing out and re-entering as new.
  const dup = state.alerts.find((x) => x._key === key && now - Date.parse(x._lastAt ?? x.at) < DEDUPE_MS);
  if (dup) {
    // Latest figures win — an operator wants the current occupancy, not the
    // reading from when the stop first went critical — but `at` stays put so the
    // chip does not claim to be newer than it is, and no second beep fires: an
    // alarm that re-sounds every few seconds for one unresolved stop is how
    // operators learn to stop hearing alarms.
    Object.assign(dup, a, { at: dup.at, _key: key, _lastAt: at, _repeats: (dup._repeats ?? 1) + 1 });
    renderAlerts();
    return;
  }

  state.alerts = [{ ...a, at, _key: key, _lastAt: at, _repeats: 1 }, ...state.alerts].slice(0, MAX_ALERTS);
  renderAlerts();
  if (a.severity === 'critical') beep({ freq: a.kind === 'DROWSINESS' ? 880 : 620, ms: 220, gain: 0.06 });
}

// ── topbar ──────────────────────────────────────────────────────────────────

function renderScenario() {
  const s = state.scenario;
  const box = $('.scenario');
  if (!s) return;
  $('#scenario-beat').textContent = s.paused ? `${s.beatLabel} · paused` : s.beatLabel;
  $('#scenario-step').textContent = `${s.beatIndex + 1}/${s.beatCount}`;
  box.dataset.live = '1';
  box.dataset.paused = s.paused ? '1' : '0';
  box.dataset.sev = s.beatKey === 'OVERCROWDED' || s.beatKey === 'FATIGUE' ? 'critical' : 'normal';
}

/**
 * Impact figures. Deliberately derived from live state rather than stored:
 * a KPI that can disagree with the panel below it is worse than no KPI.
 */
function renderKpis() {
  const crowds = [...state.crowd.values()];
  const waiting = crowds.reduce((n, c) => n + (c.count ?? 0), 0);

  // The server already derives network occupancy in `fleetState.totals`; use its
  // figure rather than a second client-side reduction, so the KPI and the fleet
  // panel below it cannot round differently or disagree about which vehicles
  // count as in service.
  const routes = state.routes ?? [];
  const seats = routes.reduce((n, r) => n + (r.seatCapacity ?? 0), 0);
  const onboard = routes.reduce((n, r) => n + (r.onboard ?? 0), 0);
  const load = state.fleet?.totals?.networkOccupancyPct
    ?? (seats > 0 ? (onboard / seats) * 100 : 0);

  const seatsAdded = (state.fleet?.recentReroutes ?? []).reduce((n, r) => n + (r.seatsAdded ?? 0), 0);

  $('#kpi-occupancy').textContent = fmt.pct(load);
  $('#kpi-waiting').textContent = fmt.int(waiting);
  $('#kpi-seats').textContent = fmt.int(seatsAdded);
  // Carbon is attributed only to journeys that were actually ticketed, so the
  // figure is a real count of passes and not a projection.
  $('#kpi-co2').textContent = (state.co2SavedKg ?? 0).toFixed(1);
}

export function addCo2(grams) {
  state.co2SavedKg = (state.co2SavedKg ?? 0) + (Number(grams) || 0) / 1000;
  renderKpis();
}

function setConnected(live) {
  state.connected = live;
  const box = $('#conn');
  box.dataset.state = live ? 'live' : 'down';
  $('#conn-text').textContent = live ? 'live' : 'reconnecting';
}

// ── modals ──────────────────────────────────────────────────────────────────

let openModal = null;

export function showModal(id) {
  const node = $(id);
  if (!node) return;
  node.hidden = false;
  openModal = node;
  node.querySelector('.btn, .modal-close')?.focus();
}

export function hideModal(id) {
  const node = id ? $(id) : openModal;
  if (!node) return;
  node.hidden = true;
  if (openModal === node) openModal = null;
}

function wireModals() {
  for (const [btn, modal] of [['#pass-close', '#pass-modal'], ['#help-close', '#help-modal']]) {
    $(btn)?.addEventListener('click', () => hideModal(modal));
  }
  $('#btn-help')?.addEventListener('click', () => showModal('#help-modal'));

  // Click the backdrop, not the card, to dismiss.
  for (const m of $$('.modal')) {
    m.addEventListener('click', (e) => { if (e.target === m) hideModal(`#${m.id}`); });
  }
}

// ── scenario control ────────────────────────────────────────────────────────

/** @param {{action:string, beat?:number}} cmd */
export async function scenario(cmd) {
  try {
    const res = await api.post('/api/v1/scenario', cmd);
    state.scenario = res.scenario;
    renderScenario();
    if (cmd.action === 'reset') await bootstrap({ reconnect: false });
  } catch (err) {
    console.error('[commuteiq] scenario command failed', err);
  }
}

/**
 * Keyboard control, per the plan: 1-6 jump to a beat, Space pauses, R resets.
 *
 * A scripted timeline with manual override is the difference between a demo
 * that survives being interrupted by a judge's question and one that doesn't —
 * the presenter can jump straight back to the beat they were describing.
 */
function wireKeys() {
  window.addEventListener('keydown', (e) => {
    // Never steal keys from a field the presenter is typing into.
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Escape') { hideModal(); return; }
    if (e.key === '?') { e.preventDefault(); showModal('#help-modal'); return; }

    if (e.key >= '1' && e.key <= '6') {
      e.preventDefault();
      scenario({ action: 'jump', beat: Number(e.key) - 1 });
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      scenario({ action: state.scenario?.paused ? 'resume' : 'pause' });
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      scenario({ action: 'reset' });
    }
  });

  $('#btn-reset')?.addEventListener('click', () => scenario({ action: 'reset' }));
}

// ── transport ───────────────────────────────────────────────────────────────

let source = null;

/**
 * Subscribe to the server's push channel.
 *
 * `EventSource` reconnects on its own, so there is no retry loop here — the
 * server sends `retry: 2000` and the browser honours it. All we do is reflect
 * the connection state in the topbar, because a console that has silently
 * stopped receiving updates while still showing numbers is actively misleading.
 */
function connect() {
  source?.close();
  source = new EventSource('/api/v1/events');

  source.addEventListener('open', () => setConnected(true));
  source.addEventListener('error', () => setConnected(false));

  const relay = (name, before) => source.addEventListener(name, (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    setConnected(true);
    before?.(payload);
    emit(name, payload);
  });

  relay('crowd', (p) => {
    if (Array.isArray(p.stops)) setCrowd(p.stops);
    else if (p.stop) setCrowd([p.stop]);
    renderKpis();
  });

  relay('fleet', (p) => { setFleet(p); renderKpis(); });

  relay('telematics', (p) => setTelematics(p.telematics ?? p));

  relay('reroute', (p) => {
    // Fold the dispatch into the history the KPI band totals, so "seats added"
    // moves the instant the bus is assigned rather than on the next full fetch.
    const history = state.fleet?.recentReroutes ?? [];
    state.fleet = { ...(state.fleet ?? {}), recentReroutes: [p, ...history].slice(0, 10) };
    renderKpis();
  });

  relay('alert', (p) => pushAlert(p));

  relay('scenario', (p) => {
    // The hub's greeting frame rides the scenario channel but carries no beat.
    if (p.hello) { setConnected(true); return; }
    state.scenario = p;
    renderScenario();
  });

  relay('reset', () => {
    state.alerts = [];
    renderAlerts();
    state.co2SavedKg = 0;
    bootstrap({ reconnect: false });
  });
}

// ── boot ────────────────────────────────────────────────────────────────────

/**
 * Load reference and live data, then let the panels redraw.
 *
 * Everything is fetched in parallel and the whole set is awaited before `boot`
 * is emitted, so no panel has to defend itself against a half-populated store.
 * @param {{reconnect?:boolean}} [opts]
 */
export async function bootstrap({ reconnect = true } = {}) {
  const [stops, network, fleet, crowd, scen] = await Promise.all([
    api.get('/api/v1/stops'),
    api.get('/api/v1/routes'),
    api.get('/api/v1/fleet/state'),
    api.get('/api/v1/cv/stops'),
    api.get('/api/v1/scenario'),
  ]);

  state.stops = stops.stops ?? [];
  // Hydrated routes, stops embedded — the geography. Fetched once here rather
  // than per panel, because both the map (polylines) and the dispatch console
  // (which routes serve the overcrowded stop) need the same answer and must not
  // be able to disagree about it.
  state.network = network.routes ?? [];
  setFleet(fleet);
  setCrowd(crowd.stops ?? []);
  state.scenario = scen.scenario ?? null;
  state.beats = scen.beats ?? [];

  renderScenario();
  renderKpis();
  emit('boot', { stops: state.stops, fleet, crowd, scenario: state.scenario });

  if (reconnect) connect();
}

async function main() {
  wireModals();
  wireKeys();

  // Panels register their subscriptions before the first `boot` is emitted.
  initCv();
  initMap();
  initEta();
  initJourney();
  initFleet();
  initTelematics();

  try {
    await bootstrap();
  } catch (err) {
    console.error('[commuteiq] boot failed', err);
    $('#scenario-beat').textContent = 'server unreachable — run: node server/index.js';
    setConnected(false);
  }

  // Keep the KPI band honest about the clock even between pushed events.
  setInterval(renderKpis, 2000);
}

main();
