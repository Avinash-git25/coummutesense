/**
 * CommuteIQ — Feature 1: computer-vision passenger density.
 *
 * ── Spec issues this module resolves ───────────────────────────────────────
 * The TRD documents GET /api/v1/cv/crowd-stream as:
 *
 *   { "success": true, "currentCount": 19, "densityStatus": "HIGH",
 *     "recommendedAction": "DISPATCH_EXTRA_BUS" }
 *
 * Three things are missing from that as written:
 *
 * 1. It never says WHICH stop the 19 people are standing at. A dashboard that
 *    plots pressure across the city cannot use a headless number, so we accept
 *    `?stopId=` and echo the stop's identity, capacity and occupancy alongside
 *    the four documented keys — which stay at the TOP LEVEL, unnested, so an
 *    existing client written against the TRD keeps working untouched.
 *
 * 2. `densityStatus` is a count band and `recommendedAction` is driven by a
 *    percentage trigger, and the TRD gives no rule connecting them. Both come
 *    from model.stopCrowd here, which derives them from one observation via
 *    domain.js. We never re-band anything locally; there is exactly one place
 *    in the codebase that knows where LOW ends and HIGH begins.
 *
 * 3. The stream is read-only. PRD Feature 1 promises the crowding score "syncs
 *    directly with backend API to trigger system alerts", but the CV detector
 *    runs in the BROWSER — on-device, because shipping frames to a server would
 *    need a model we cannot install and a network we cannot assume. Its per-frame
 *    count therefore has to travel back inwards. POST /api/v1/cv/ingest is that
 *    return path, and it is where the F1 -> F4 hand-off actually fires.
 *
 * ── Why the alert is edge-triggered ────────────────────────────────────────
 * A browser detector pushes a frame several times a second. Alerting whenever
 * occupancy happens to sit above the trigger would emit a critical alert per
 * frame and bury the operator. So we read the PREVIOUS observation before
 * overwriting it and only alert on the crossing — the same latch the scenario
 * driver keeps in sim.js, except persisted in the store rather than in memory,
 * because HTTP ingestion has no tick to hang state off.
 */

import { EVENTS } from '../bus.js';
import { isOvercrowded, occupancyPct } from '../domain.js';
import { allStopCrowd, hottestStop, stopCrowd, routesServingStop } from '../model.js';
import { badRequest, notFound } from '../http-error.js';

/**
 * How far a predicted head count may sit from the observed truth and still
 * count as correct, in people.
 *
 * Not a domain threshold — nothing in the system behaves differently because of
 * it — so it does not belong in domain.js. It is a measurement convention for
 * the accuracy figure we quote in the UI: a crowd of nineteen counted as
 * eighteen is a correct read for dispatch purposes, and pretending otherwise
 * would understate a detector that is doing its job.
 */
export const COUNT_TOLERANCE = 1;

/** Longest `source` label we will store, so an SSE frame cannot be padded out. */
const MAX_SOURCE_LEN = 64;

/**
 * Resolve the stop a crowd query is about.
 *
 * With no `stopId` we answer for the busiest stop rather than erroring, because
 * the dashboard's opening render has nothing to name yet and the operator's
 * first question is always "where is it worst".
 *
 * @param {import('../db.js').Store} store
 * @param {URLSearchParams} query
 * @returns {object} a model.stopCrowd view
 */
function resolveStopCrowd(store, query) {
  const requested = query?.get('stopId')?.trim();

  if (requested) {
    const crowd = stopCrowd(store, requested);
    if (!crowd) throw notFound(`unknown stop: ${requested}`);
    return crowd;
  }

  const hottest = hottestStop(store);
  if (!hottest) throw notFound('no stops are loaded');
  return hottest;
}

/**
 * GET /api/v1/cv/crowd-stream — the TRD's documented crowd response.
 *
 * Query: `?stopId=ST_01` (optional; defaults to the busiest stop).
 */
export async function crowdStream(ctx) {
  const crowd = resolveStopCrowd(ctx.store, ctx.query);

  return {
    // ── the four keys the TRD documents, verbatim and top-level ──
    success: true,
    currentCount: crowd.count,
    densityStatus: crowd.densityStatus,
    recommendedAction: crowd.recommendedAction,

    // ── context the dashboard needs to render and attribute the number ──
    stopId: crowd.stopId,
    stopName: crowd.name,
    capacity: crowd.capacity,
    occupancyPct: crowd.occupancyPct,
    occupancyBand: crowd.occupancyBand,
    observedAt: crowd.observedAt,
    source: crowd.source,
  };
}

/**
 * GET /api/v1/cv/stops — crowd state for every stop, busiest first.
 *
 * The single-stop endpoint answers "how bad is it here"; the map needs "how bad
 * is it everywhere" in one round trip, and polling ten stops individually would
 * give a torn snapshot where each stop was read at a different instant.
 */
export async function crowdAllStops(ctx) {
  const { store } = ctx;
  const stops = allStopCrowd(store);

  return {
    success: true,
    stops,
    hottest: stops[0] ?? null,   // allStopCrowd is already sorted by pressure
    summary: {
      totalWaiting: stops.reduce((sum, s) => sum + s.count, 0),
      overcrowdedCount: stops.filter((s) => isOvercrowded(s.occupancyPct)).length,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * POST /api/v1/cv/ingest — accept one frame's head count from the browser
 * detector and, on a crossing, raise the overcrowding alert.
 *
 * Body: { stopId, count, source?, frameId?, groundTruth?, inferenceMs? }
 *
 * `groundTruth` is optional and comes from the demo's labelled clip. When it is
 * present we return the error for that frame, which is how the UI can quote a
 * measured accuracy instead of a marketing one.
 */
export async function ingestCrowd(ctx) {
  const { store, body, publish } = ctx;
  const { stopId, count, source, frameId, groundTruth, inferenceMs } = body ?? {};

  // ── validation ───────────────────────────────────────────────────────────
  // Counts arrive from client-side JavaScript, so a non-number here means the
  // detector is broken, not that the caller was being loose. Reject rather than
  // coerce: a silently-coerced NaN would land in the store as an occupancy of 0
  // and quietly clear a real overcrowding alert.
  if (typeof stopId !== 'string' || stopId.trim() === '') {
    throw badRequest('stopId is required');
  }
  const stop = store.stops.get(stopId.trim());
  if (!stop) throw notFound(`unknown stop: ${stopId}`);

  if (!Number.isInteger(count) || count < 0) {
    throw badRequest('count must be an integer >= 0', { count });
  }

  if (source !== undefined && (typeof source !== 'string' || source.trim() === '')) {
    throw badRequest('source must be a non-empty string when supplied');
  }
  if (frameId !== undefined && typeof frameId !== 'string' && !Number.isInteger(frameId)) {
    throw badRequest('frameId must be a string or an integer when supplied');
  }
  if (inferenceMs !== undefined && (!Number.isFinite(inferenceMs) || inferenceMs < 0)) {
    throw badRequest('inferenceMs must be a number >= 0 when supplied');
  }
  if (groundTruth !== undefined && (!Number.isInteger(groundTruth) || groundTruth < 0)) {
    throw badRequest('groundTruth must be an integer >= 0 when supplied');
  }

  // ── read the previous state BEFORE overwriting it ────────────────────────
  // The whole edge-trigger depends on this ordering. Both sides of the
  // comparison use the stop's CURRENT capacity, so a capacity correction can
  // never fake a crossing that no crowd actually made.
  const key = `crowd_${stop._id}`;
  const previous = store.crowd_observations.get(key);
  const wasOvercrowded = previous ? isOvercrowded(occupancyPct(previous.count, stop.capacity)) : false;

  const observedAt = new Date().toISOString();
  /** Built fresh rather than merged over `previous`, so a frameId from an
   *  earlier frame cannot linger on an observation that did not carry one. */
  const observation = {
    _id: key,
    stopId: stop._id,
    count,
    capacity: stop.capacity,
    source: source ? source.trim().slice(0, MAX_SOURCE_LEN) : 'browser-cv',
    observedAt,
  };
  if (frameId !== undefined) observation.frameId = frameId;
  if (inferenceMs !== undefined) observation.inferenceMs = inferenceMs;
  store.crowd_observations.put(observation);

  const crowd = stopCrowd(store, stop._id);
  const nowOvercrowded = isOvercrowded(crowd.occupancyPct);
  const alerted = nowOvercrowded && !wasOvercrowded;

  // ── push ─────────────────────────────────────────────────────────────────
  // Carrying the whole city alongside the one stop that changed costs a few
  // hundred bytes and lets the dashboard handle sim ticks and browser ingests
  // with one CROWD listener instead of two divergent code paths.
  const stops = allStopCrowd(store);
  publish(EVENTS.CROWD, { stop: crowd, stops, hottest: stops[0] ?? null, origin: 'ingest' });

  if (alerted) {
    publish(EVENTS.ALERT, {
      kind: 'OVERCROWDING',
      severity: 'critical',
      stopId: crowd.stopId,
      stopName: crowd.name,
      count: crowd.count,
      capacity: crowd.capacity,
      occupancyPct: crowd.occupancyPct,
      // Sourced from the crowd view, not written out as a literal: the
      // band -> action mapping is domain.recommendedAction's to own, and a
      // literal here would silently disagree with it the moment it changes.
      recommendedAction: crowd.recommendedAction,
      // Which services the operator can actually add a bus to, so the alert is
      // one click from a dispatch rather than a prompt to go and look it up.
      routeIds: routesServingStop(store, crowd.stopId).map((r) => r._id),
      at: observedAt,
    });
  }

  const response = { success: true, crowd, alerted };

  if (groundTruth !== undefined) {
    const absError = Math.abs(groundTruth - count);
    response.accuracy = {
      groundTruth,
      predicted: count,
      absError,
      withinTolerance: absError <= COUNT_TOLERANCE,
    };
  }

  return response;
}
