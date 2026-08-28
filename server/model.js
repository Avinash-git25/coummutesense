/**
 * CommuteIQ — read model.
 *
 * Derived views over the store. Every value the TRD stores redundantly
 * (`congestionIndex`, `drowsinessFlag`) is computed here instead of persisted,
 * so it can never drift out of sync with the field it depends on.
 *
 * The TRD's `routes` schema embeds its stops inline. We store stops in their own
 * collection to avoid duplicating a stop across the five routes that serve it,
 * then re-embed them in `hydrateRoute` so API responses keep the documented
 * shape exactly.
 */

import {
  classifyCount,
  classifyOccupancy,
  congestionIndex,
  occupancyPct,
  recommendedAction,
  roadDistanceKm,
  DrowsinessDetector,
  stabilityScore,
} from './domain.js';

/**
 * Route document in the TRD's documented shape: stops embedded, derived
 * `congestionIndex` attached.
 * @param {import('./db.js').Store} store
 * @param {object} route
 */
export function hydrateRoute(store, route) {
  const stops = route.stopIds
    .map((id) => store.stops.get(id))
    .filter(Boolean)
    .map(({ _id, name, lat, lng, capacity }) => ({ stopId: _id, name, lat, lng, capacity }));

  return {
    _id: route._id,
    routeName: route.routeName,
    activeVehicles: [...route.activeVehicles],
    congestionIndex: congestionIndex(route.currentDemand), // derived, never stored
    currentDemand: route.currentDemand,
    headwayMins: route.headwayMins,
    signalCongestionScore: route.signalCongestionScore,
    stops,
  };
}

/** Total seats currently serving a route. */
export function routeSeatCapacity(store, routeId) {
  return store.vehicles
    .find((v) => v.routeId === routeId && v.status === 'in_service')
    .reduce((sum, v) => sum + (v.capacity ?? 0), 0);
}

/** Riders currently aboard a route's vehicles. */
export function routeOnboard(store, routeId) {
  return store.vehicles
    .find((v) => v.routeId === routeId && v.status === 'in_service')
    .reduce((sum, v) => sum + (v.onboard ?? 0), 0);
}

/** End-to-end road distance of a route, km. */
export function routeDistanceKm(store, route) {
  let km = 0;
  for (let i = 1; i < route.stopIds.length; i += 1) {
    const a = store.stops.get(route.stopIds[i - 1]);
    const b = store.stops.get(route.stopIds[i]);
    if (a && b) km += roadDistanceKm(a.lat, a.lng, b.lat, b.lng);
  }
  return Math.round(km * 1000) / 1000;
}

/**
 * Operational snapshot of one route, including the stress value the Feature 4
 * heatmap renders.
 */
export function routeState(store, routeId) {
  const route = store.routes.get(routeId);
  if (!route) return null;

  const seats = routeSeatCapacity(store, routeId);
  const onboard = routeOnboard(store, routeId);
  const vehicles = store.vehicles.find((v) => v.routeId === routeId);

  return {
    routeId: route._id,
    routeName: route.routeName,
    currentDemand: route.currentDemand,
    congestionIndex: congestionIndex(route.currentDemand),
    stressBand: classifyOccupancy(route.currentDemand),
    overcrowded: classifyOccupancy(route.currentDemand) === 'CRITICAL',
    seatCapacity: seats,
    onboard,
    seatsFree: Math.max(0, seats - onboard),
    headwayMins: route.headwayMins,
    signalCongestionScore: route.signalCongestionScore,
    distanceKm: routeDistanceKm(store, route),
    vehicleCount: vehicles.length,
    vehicles: vehicles.map((v) => ({
      vehicleId: v._id,
      capacity: v.capacity,
      onboard: v.onboard,
      occupancyPct: occupancyPct(v.onboard, v.capacity),
      status: v.status,
      driverId: v.driverId,
      speedKmph: v.speedKmph,
      progress: v.progress,
    })),
  };
}

/** Whole-fleet view backing GET /api/v1/fleet/state and the heatmap. */
export function fleetState(store) {
  const routes = store.routes.all().map((r) => routeState(store, r._id));
  const idle = store.vehicles
    .find((v) => v.status === 'idle')
    .map(({ _id, capacity, depotStopId, driverId }) => ({
      vehicleId: _id, capacity, depotStopId, driverId,
    }));

  const seatCapacity = routes.reduce((s, r) => s + r.seatCapacity, 0);
  const onboard = routes.reduce((s, r) => s + r.onboard, 0);

  return {
    routes,
    idleVehicles: idle,
    totals: {
      routeCount: routes.length,
      vehiclesInService: routes.reduce((s, r) => s + r.vehicleCount, 0),
      idleVehicles: idle.length,
      seatCapacity,
      onboard,
      networkOccupancyPct: occupancyPct(onboard, seatCapacity),
      overcrowdedRoutes: routes.filter((r) => r.overcrowded).map((r) => r.routeId),
    },
  };
}

/**
 * Crowd state at one stop. This is the bridge between Feature 1's count-based
 * label and Feature 4's percentage-based trigger: both are returned, derived
 * from the same observation.
 */
export function stopCrowd(store, stopId) {
  const stop = store.stops.get(stopId);
  if (!stop) return null;
  const obs = store.crowd_observations.get(`crowd_${stopId}`);
  const count = obs?.count ?? 0;
  const pct = occupancyPct(count, stop.capacity);

  return {
    stopId,
    name: stop.name,
    lat: stop.lat,
    lng: stop.lng,
    count,
    capacity: stop.capacity,
    densityStatus: classifyCount(count),      // Feature 1 label
    occupancyPct: pct,                        // Feature 4 input
    occupancyBand: classifyOccupancy(pct),
    recommendedAction: recommendedAction(pct),
    observedAt: obs?.observedAt ?? null,
    source: obs?.source ?? 'none',
  };
}

/** Every stop's crowd state, busiest first. */
export function allStopCrowd(store) {
  return store.stops
    .all()
    .map((s) => stopCrowd(store, s._id))
    .sort((a, b) => b.occupancyPct - a.occupancyPct);
}

/** The stop under the most pressure right now. */
export function hottestStop(store) {
  return allStopCrowd(store)[0] ?? null;
}

/** Routes that serve a given stop. */
export function routesServingStop(store, stopId) {
  return store.routes.find((r) => r.stopIds.includes(stopId));
}

/**
 * Interpolated position of a vehicle along its route polyline.
 * @returns {{lat:number, lng:number, nextStopId:string|null, legFraction:number}|null}
 */
export function vehiclePosition(store, vehicle) {
  if (!vehicle?.routeId) {
    const depot = vehicle?.depotStopId ? store.stops.get(vehicle.depotStopId) : null;
    return depot ? { lat: depot.lat, lng: depot.lng, nextStopId: null, legFraction: 0 } : null;
  }
  const route = store.routes.get(vehicle.routeId);
  if (!route) return null;

  const pts = route.stopIds.map((id) => store.stops.get(id)).filter(Boolean);
  if (pts.length < 2) return pts[0] ? { lat: pts[0].lat, lng: pts[0].lng, nextStopId: null, legFraction: 0 } : null;

  // Cumulative leg lengths so progress maps to real distance, not stop index.
  const legs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const d = roadDistanceKm(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    legs.push(d);
    total += d;
  }

  const target = Math.min(Math.max(vehicle.progress ?? 0, 0), 1) * total;
  let walked = 0;
  for (let i = 0; i < legs.length; i += 1) {
    if (walked + legs[i] >= target || i === legs.length - 1) {
      const f = legs[i] === 0 ? 0 : (target - walked) / legs[i];
      const a = pts[i];
      const b = pts[i + 1];
      return {
        lat: a.lat + (b.lat - a.lat) * f,
        lng: a.lng + (b.lng - a.lng) * f,
        nextStopId: route.stopIds[i + 1] ?? null,
        legFraction: Math.min(Math.max(f, 0), 1),
      };
    }
    walked += legs[i];
  }
  return null;
}

/**
 * Telematics view for one vehicle, with `drowsinessFlag` DERIVED rather than
 * read from storage.
 *
 * @param {import('./db.js').Store} store
 * @param {string} vehicleId
 * @param {Map<string, DrowsinessDetector>} detectors per-vehicle debounce state
 */
export function telematicsView(store, vehicleId, detectors) {
  const t = store.telematics_current.get(`telematics_${vehicleId}`);
  if (!t) return null;
  const driver = store.drivers.get(t.driverId);

  let detector = detectors.get(vehicleId);
  if (!detector) {
    detector = new DrowsinessDetector();
    detectors.set(vehicleId, detector);
  }
  const fatigue = detector.push(t.earRatio);

  return {
    vehicleId: t.vehicleId,
    driverId: t.driverId,
    driverName: driver?.name ?? 'Unknown',
    speedKmph: t.speedKmph,
    harshBrakingEvents: t.harshBrakingEvents,
    earRatio: t.earRatio,
    hoursOnDuty: t.hoursOnDuty,
    drowsinessFlag: fatigue.drowsy,          // derived, never stored
    closedMs: fatigue.closedMs,
    fatigueProgressPct: fatigue.progressPct,
    justTriggered: fatigue.justTriggered,
    stabilityScore: stabilityScore(t),
    timestamp: t.timestamp,
  };
}
