/**
 * CommuteIQ — reference data: routes and stops.
 *
 * The read-only backbone of the console. The map layer, the route pickers and
 * the journey planner's origin/destination lists all come from here, so these
 * three handlers are the only place that answers "what does the network look
 * like" — nothing else in the API needs to describe geography.
 *
 * ── Spec issue this module resolves ────────────────────────────────────────
 * The TRD's `routes` schema embeds each route's stops inline, as an array of
 * full stop documents. Taken literally that duplicates every interchange: five
 * routes serve ST_01, so Central Station would exist five times over, and the
 * moment one copy's capacity or coordinates were corrected the others would
 * quietly disagree — with no way to tell which copy the dispatcher was looking
 * at. So stops live in their own collection, keyed by `_id`, and routes hold
 * only `stopIds`. `model.hydrateRoute` re-embeds them on read, which means the
 * response the client receives still matches the documented shape exactly
 * while there remains exactly one stored copy of each stop.
 *
 * The same argument applies to `congestionIndex`, which the TRD stores next to
 * `currentDemand`: it is derived per request by `hydrateRoute`, never written.
 */

import { isOvercrowded } from '../domain.js';
import { allStopCrowd, fleetState, hydrateRoute, routeState, stopCrowd } from '../model.js';
import { badRequest, notFound } from '../http-error.js';

/**
 * Read a query parameter as a trimmed string.
 *
 * An absent parameter and an empty one are treated alike, because the console's
 * filter controls send `?mode=` for their "all modes" option and that plainly
 * means unfiltered rather than "match stops serving no modes".
 *
 * @param {URLSearchParams} query
 * @param {string} name
 * @returns {string|null} the value, or null when not usefully present
 */
function optionalParam(query, name) {
  const raw = query?.get(name);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Aggregate a set of crowd states into the counters the stop list header shows.
 * Deliberately computed over the FILTERED set: an operator who has narrowed the
 * list to one route wants that route's waiting total, not the city's.
 *
 * @param {Array<{count:number, occupancyPct:number}>} crowds
 */
function summariseStops(crowds) {
  return {
    stopCount: crowds.length,
    totalWaiting: crowds.reduce((sum, s) => sum + s.count, 0),
    overcrowdedCount: crowds.filter((s) => isOvercrowded(s.occupancyPct)).length,
  };
}

/**
 * GET /api/v1/routes — every route in the documented shape, plus live state.
 *
 * `fleetState` already derives a `routeState` for every route, so we index its
 * output rather than calling `routeState` a second time per route: each call
 * re-reads and re-parses the whole vehicles collection, and the summary needs
 * the fleet totals anyway.
 *
 * @param {object} ctx handler context
 * @returns {Promise<object>} { success, routes, summary, generatedAt }
 */
export async function listRoutes(ctx) {
  const { store } = ctx;
  const fleet = fleetState(store);
  const stateById = new Map(fleet.routes.map((s) => [s.routeId, s]));

  const routes = store.routes.all().map((route) => ({
    ...hydrateRoute(store, route),
    state: stateById.get(route._id) ?? null,
  }));

  return {
    success: true,
    routes,
    summary: {
      routeCount: fleet.totals.routeCount,
      overcrowdedRoutes: fleet.totals.overcrowdedRoutes,
      networkOccupancyPct: fleet.totals.networkOccupancyPct,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * GET /api/v1/routes/:routeId — one route, its operational state, and the crowd
 * state of each stop along it.
 *
 * The crowd states stay in travelling order rather than busiest-first, because
 * on a single route the sequence is the information: it tells the dispatcher
 * whether the pressure is ahead of the bus or behind it.
 *
 * @param {object} ctx handler context
 * @returns {Promise<object>} { success, route, state, stopCrowd, summary }
 */
export async function getRoute(ctx) {
  const { store, params } = ctx;
  const routeId = typeof params?.routeId === 'string' ? params.routeId.trim() : '';
  if (routeId === '') throw badRequest('routeId is required');

  const route = store.routes.get(routeId);
  if (!route) throw notFound(`unknown route: ${routeId}`);

  // A stopId with no stop document behind it is a broken seed, not a client
  // error; drop it here so one bad reference cannot take the whole panel down.
  const crowds = route.stopIds.map((id) => stopCrowd(store, id)).filter(Boolean);

  return {
    success: true,
    route: hydrateRoute(store, route),
    state: routeState(store, routeId),
    stopCrowd: crowds,
    summary: summariseStops(crowds),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * GET /api/v1/stops — every stop with its live crowd state, busiest first.
 *
 * Optional filters:
 *   ?mode=metro      stops whose `modes` array includes that mode
 *   ?routeId=route_104   stops served by that one route
 *
 * An unknown `mode` is rejected rather than answered with an empty list: a typo
 * in a filter and a genuinely empty result look identical to the caller, and the
 * mode vocabulary comes from the stop data itself so we can name the valid ones.
 *
 * @param {object} ctx handler context
 * @returns {Promise<object>} { success, stops, filters, summary, generatedAt }
 */
export async function listStops(ctx) {
  const { store, query } = ctx;
  const mode = optionalParam(query, 'mode');
  const routeId = optionalParam(query, 'routeId');

  const stopDocs = store.stops.all();
  const byId = new Map(stopDocs.map((s) => [s._id, s]));

  // Modes are lower-case in the seed data; compare case-insensitively so
  // ?mode=Metro from a hand-typed URL behaves the same as ?mode=metro.
  const knownModes = new Set();
  for (const s of stopDocs) for (const m of s.modes ?? []) knownModes.add(String(m).toLowerCase());

  const wantedMode = mode?.toLowerCase() ?? null;
  if (wantedMode !== null && !knownModes.has(wantedMode)) {
    throw badRequest(`unknown mode: ${mode}`, { availableModes: [...knownModes].sort() });
  }

  /** @type {Set<string>|null} null means no route restriction */
  let allowedIds = null;
  if (routeId !== null) {
    const route = store.routes.get(routeId);
    if (!route) throw notFound(`unknown route: ${routeId}`);
    allowedIds = new Set(route.stopIds);
  }

  // allStopCrowd is already sorted busiest-first, and filtering preserves that
  // order, so the client never has to re-sort.
  const stops = allStopCrowd(store)
    .filter((s) => allowedIds === null || allowedIds.has(s.stopId))
    .filter((s) => {
      if (wantedMode === null) return true;
      const modes = byId.get(s.stopId)?.modes ?? [];
      return modes.some((m) => String(m).toLowerCase() === wantedMode);
    })
    // `modes` and `zone` are not part of the crowd view, but a client that can
    // filter by mode has to be able to show which modes a stop serves.
    .map((s) => ({
      ...s,
      modes: byId.get(s.stopId)?.modes ?? [],
      zone: byId.get(s.stopId)?.zone ?? null,
    }));

  return {
    success: true,
    stops,
    filters: { mode: wantedMode, routeId },
    summary: summariseStops(stops),
    generatedAt: new Date().toISOString(),
  };
}
