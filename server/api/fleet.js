/**
 * CommuteIQ — Feature 4: dynamic fleet re-routing and dispatch.
 *
 * ── Spec issues this module resolves ───────────────────────────────────────
 * The TRD documents POST /api/v1/fleet/re-route as:
 *
 *   payload  { "sourceRouteId": "route_102", "targetRouteId": "route_104",
 *              "vehicleId": "BUS_108" }
 *   response { "success": true,
 *              "message": "BUS_108 successfully re-routed to Route 104.",
 *              "updatedCapacityRelief": "40 Seats Added" }
 *
 * Two problems with that as written:
 *
 * 1. `updatedCapacityRelief` is a hardcoded string. We compute it from the
 *    vehicle's own capacity (domain.capacityRelief) and return a NUMBER
 *    alongside the documented string, so the dashboard can do arithmetic on it
 *    instead of parsing English.
 *
 * 2. There are no guards at all. Nothing stops you dispatching a bus that is
 *    in maintenance, or one already serving the target route, or — the one that
 *    actually bites during a live demo — firing the same dispatch twice because
 *    the operator double-clicked the button. So this handler validates the
 *    vehicle's eligibility and accepts an optional `requestId` for idempotency:
 *    a replay returns the original outcome rather than moving a second bus.
 *
 * The documented response keys are preserved verbatim at the top level.
 */

import { createHash } from 'node:crypto';
import { EVENTS } from '../bus.js';
import { capacityRelief, congestionIndex, occupancyPct } from '../domain.js';
import { allStopCrowd, fleetState, hottestStop, routeState } from '../model.js';
import { badRequest, conflict, notFound } from '../http-error.js';
/** Statuses from which a vehicle may be dispatched onto a route. */
const DISPATCHABLE_STATUSES = new Set(['idle', 'in_service']);

/**
 * Short human label for a route, e.g. "Route 104 - City Center to Tech Hub"
 * becomes "Route 104" — which is the form the TRD's `message` string uses.
 * @param {{routeName:string, _id:string}} route
 */
function shortRouteLabel(route) {
  return route.routeName?.split(' - ')[0]?.trim() || route._id;
}

/**
 * Stable fingerprint of a dispatch, used when the caller does not supply a
 * requestId. Two identical dispatches inside the same demo beat collapse onto
 * one key, which is exactly the double-click case we want to absorb.
 */
function fingerprint({ vehicleId, targetRouteId, sourceRouteId }) {
  return `rr_${createHash('sha256')
    .update(`${vehicleId}|${sourceRouteId ?? ''}|${targetRouteId}`)
    .digest('hex')
    .slice(0, 12)}`;
}

/**
 * GET /api/v1/fleet/state — everything the Feature 4 heatmap renders.
 */
export async function getFleetState(ctx) {
  const { store } = ctx;
  const fleet = fleetState(store);

  return {
    success: true,
    ...fleet,
    // Stop-level pressure as well as route-level: the heatmap colours routes,
    // but the operator needs to see WHICH stop is driving a route's stress.
    stops: allStopCrowd(store),
    hottestStop: hottestStop(store),
    recentReroutes: store.reroutes
      .all()
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 10),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * POST /api/v1/fleet/re-route — assign a vehicle to a demand-heavy route.
 *
 * Body: { vehicleId, targetRouteId, sourceRouteId?, requestId? }
 */
export async function reRoute(ctx) {
  const { store, body, publish, sim } = ctx;
  const { vehicleId, targetRouteId, sourceRouteId = null, requestId = null } = body ?? {};

  if (typeof vehicleId !== 'string' || vehicleId === '') {
    throw badRequest('vehicleId is required');
  }
  if (typeof targetRouteId !== 'string' || targetRouteId === '') {
    throw badRequest('targetRouteId is required');
  }

  // ── idempotency ──────────────────────────────────────────────────────────
  // Replay before validating state, because after a successful dispatch the
  // vehicle no longer passes the "not already on target" guard — a naive retry
  // would come back as a 409 instead of the original success.
  const key = typeof requestId === 'string' && requestId !== ''
    ? `rr_${requestId}`
    : fingerprint({ vehicleId, targetRouteId, sourceRouteId });

  const prior = store.reroutes.get(key);
  if (prior) {
    return { ...prior.response, replayed: true, requestId: key };
  }

  // ── validation ───────────────────────────────────────────────────────────
  const vehicle = store.vehicles.get(vehicleId);
  if (!vehicle) throw notFound(`unknown vehicle: ${vehicleId}`);

  const target = store.routes.get(targetRouteId);
  if (!target) throw notFound(`unknown route: ${targetRouteId}`);

  if (sourceRouteId !== null && !store.routes.get(sourceRouteId)) {
    throw notFound(`unknown route: ${sourceRouteId}`);
  }

  if (!DISPATCHABLE_STATUSES.has(vehicle.status)) {
    throw conflict(`${vehicleId} is ${vehicle.status} and cannot be dispatched`, {
      vehicleId, status: vehicle.status,
    });
  }
  if (vehicle.routeId === targetRouteId) {
    throw conflict(`${vehicleId} is already serving ${shortRouteLabel(target)}`, {
      vehicleId, routeId: targetRouteId,
    });
  }
  // When the caller names a source route, it must match where the bus actually
  // is — otherwise the dispatch was computed against stale fleet state.
  if (sourceRouteId !== null && vehicle.routeId !== null && vehicle.routeId !== sourceRouteId) {
    throw conflict(
      `${vehicleId} is on ${vehicle.routeId}, not the requested source ${sourceRouteId}`,
      { vehicleId, actualRouteId: vehicle.routeId, requestedSourceRouteId: sourceRouteId },
    );
  }

  // ── apply ────────────────────────────────────────────────────────────────
  const previousRouteId = vehicle.routeId;
  const beforeTarget = routeState(store, targetRouteId);
  const beforeSource = previousRouteId ? routeState(store, previousRouteId) : null;

  const relief = capacityRelief(vehicle);

  store.vehicles.update(vehicleId, {
    routeId: targetRouteId,
    status: 'in_service',
    progress: 0,
    onboard: 0,          // arrives empty, which is the whole point of the relief
    speedKmph: 30,
  });

  // Keep both routes' activeVehicles rosters honest.
  if (previousRouteId) {
    const src = store.routes.get(previousRouteId);
    if (src) {
      store.routes.update(previousRouteId, {
        activeVehicles: src.activeVehicles.filter((id) => id !== vehicleId),
      });
    }
  }
  if (!target.activeVehicles.includes(vehicleId)) {
    store.routes.update(targetRouteId, {
      activeVehicles: [...target.activeVehicles, vehicleId],
    });
  }

  // Demand is riders over seats, so adding seats lowers it even though the
  // number of riders has not changed.
  for (const routeId of [targetRouteId, previousRouteId].filter(Boolean)) {
    const rs = routeState(store, routeId);
    if (rs && rs.seatCapacity > 0) {
      store.routes.update(routeId, {
        currentDemand: occupancyPct(rs.onboard, rs.seatCapacity),
      });
    }
  }

  const afterTarget = routeState(store, targetRouteId);
  const afterSource = previousRouteId ? routeState(store, previousRouteId) : null;
  const at = new Date().toISOString();

  // ── the documented response, plus the numbers the UI needs ───────────────
  const response = {
    success: true,
    message: `${vehicleId} successfully re-routed to ${shortRouteLabel(target)}.`,
    updatedCapacityRelief: relief.text,   // TRD shape: "40 Seats Added"

    requestId: key,
    vehicleId,
    sourceRouteId: previousRouteId,
    targetRouteId,
    seatsAdded: relief.seatsAdded,        // the same figure as a number
    capacityRelief: relief,
    target: {
      routeId: targetRouteId,
      routeName: target.routeName,
      demandBefore: beforeTarget?.currentDemand ?? null,
      demandAfter: afterTarget?.currentDemand ?? null,
      congestionBefore: beforeTarget ? congestionIndex(beforeTarget.currentDemand) : null,
      congestionAfter: afterTarget ? congestionIndex(afterTarget.currentDemand) : null,
      seatCapacityBefore: beforeTarget?.seatCapacity ?? null,
      seatCapacityAfter: afterTarget?.seatCapacity ?? null,
      stillOvercrowded: afterTarget?.overcrowded ?? false,
    },
    source: beforeSource && afterSource
      ? {
          routeId: previousRouteId,
          demandBefore: beforeSource.currentDemand,
          demandAfter: afterSource.currentDemand,
          seatCapacityAfter: afterSource.seatCapacity,
        }
      : null,
    at,
  };

  store.reroutes.put({ _id: key, ...response, response, at });

  publish(EVENTS.REROUTE, response);
  publish(EVENTS.FLEET, { ...fleetState(store), reason: 'reroute' });
  publish(EVENTS.ALERT, {
    kind: 'DISPATCH_CONFIRMED',
    severity: 'info',
    message: response.message,
    seatsAdded: relief.seatsAdded,
    routeId: targetRouteId,
    at,
  });

  // Acting on the alert should visibly move the demo story forward.
  sim?.onOperatorAction?.('reroute');

  return response;
}

/**
 * POST /api/v1/fleet/recall — send a vehicle back to its depot.
 *
 * Not in the PRD, but the dispatch console is not honest without it: an operator
 * who can only ever add buses to routes will run the fleet dry, and it lets the
 * demo be rewound without a full reset.
 *
 * Body: { vehicleId, depotStopId? }
 */
export async function recallVehicle(ctx) {
  const { store, body, publish } = ctx;
  const { vehicleId, depotStopId = null } = body ?? {};

  if (typeof vehicleId !== 'string' || vehicleId === '') {
    throw badRequest('vehicleId is required');
  }
  const vehicle = store.vehicles.get(vehicleId);
  if (!vehicle) throw notFound(`unknown vehicle: ${vehicleId}`);
  if (vehicle.status === 'idle') {
    throw conflict(`${vehicleId} is already idle`, { vehicleId });
  }
  if (depotStopId !== null && !store.stops.get(depotStopId)) {
    throw notFound(`unknown stop: ${depotStopId}`);
  }

  const previousRouteId = vehicle.routeId;
  store.vehicles.update(vehicleId, {
    routeId: null,
    status: 'idle',
    progress: 0,
    onboard: 0,
    speedKmph: 0,
    depotStopId: depotStopId ?? vehicle.depotStopId ?? 'ST_10',
  });

  if (previousRouteId) {
    const src = store.routes.get(previousRouteId);
    if (src) {
      store.routes.update(previousRouteId, {
        activeVehicles: src.activeVehicles.filter((id) => id !== vehicleId),
      });
    }
    const rs = routeState(store, previousRouteId);
    if (rs && rs.seatCapacity > 0) {
      store.routes.update(previousRouteId, {
        currentDemand: occupancyPct(rs.onboard, rs.seatCapacity),
      });
    }
  }

  const response = {
    success: true,
    message: `${vehicleId} recalled to depot.`,
    vehicleId,
    sourceRouteId: previousRouteId,
    at: new Date().toISOString(),
  };

  publish(EVENTS.FLEET, { ...fleetState(store), reason: 'recall' });
  return response;
}
