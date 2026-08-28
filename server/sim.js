/**
 * CommuteIQ — simulation clock and demo scenario driver.
 *
 * ── Why a scripted scenario? ───────────────────────────────────────────────
 * The centrepiece of this prototype is a causal chain across two features:
 * crowding detected by Feature 1 must trigger a dispatch recommendation in
 * Feature 4. If crowd numbers merely drifted at random, that chain would fire
 * whenever it felt like it — which is fatal when you have a few minutes in front
 * of judges.
 *
 * So the city runs on a scripted timeline of BEATS with an operator override:
 * `R` resets, `1`-`6` jump straight to any beat, space pauses. The demo becomes
 * repeatable and you can re-run the money shot on request.
 *
 * The PRNG is seeded, so every run of the demo looks identical.
 */

import { EVENTS } from './bus.js';
import {
  EAR_THRESHOLD,
  classifyOccupancy,
  congestionIndex,
  isOvercrowded,
  occupancyPct,
  recommendedAction,
} from './domain.js';
import { allStopCrowd, fleetState, routeState, telematicsView, hottestStop } from './model.js';

/** Telemetry sample interval. 250ms is fast enough for the 2s fatigue window. */
export const TICK_MS = 250;

/** The stop and driver the scenario puts under pressure. */
export const FOCUS_STOP_ID = 'ST_01';
export const FOCUS_ROUTE_ID = 'route_104';
export const FOCUS_VEHICLE_ID = 'BUS_101';

/**
 * Demo timeline. `awaitsOperator` beats hold until the operator acts, then fall
 * through after `durationMs` anyway so an unattended demo still progresses.
 */
export const BEATS = [
  {
    key: 'NOMINAL',
    label: 'City nominal — all routes within capacity',
    durationMs: 6000,
    stopTarget: 12,
    earTarget: 0.26,
  },
  {
    key: 'CROWD_BUILD',
    label: 'Crowd building at Central Station',
    durationMs: 11000,
    stopTarget: 19,
    earTarget: 0.26,
  },
  {
    key: 'OVERCROWDED',
    label: 'Overcrowding detected — extra bus recommended',
    durationMs: 30000,
    awaitsOperator: true,
    stopTarget: 21,
    earTarget: 0.25,
  },
  {
    key: 'DISPATCHED',
    label: 'Extra capacity dispatched — pressure relieving',
    durationMs: 9000,
    stopTarget: 10,
    earTarget: 0.24,
  },
  {
    key: 'FATIGUE',
    label: 'Driver fatigue rising on BUS_101',
    durationMs: 15000,
    stopTarget: 9,
    earTarget: 0.15, // below EAR_THRESHOLD → alert after EAR_SUSTAINED_MS
  },
  {
    key: 'STABLE',
    label: 'Network stable — driver alerted and responsive',
    durationMs: null, // terminal; holds until reset
    stopTarget: 11,
    earTarget: 0.29,
  },
];

/** Deterministic PRNG (mulberry32) so every demo run is identical. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Move `current` a fraction of the way to `target`, with a little noise. */
function ease(current, target, rate, noise, rand) {
  const next = current + (target - current) * rate;
  return next + (rand() - 0.5) * noise;
}

/**
 * @param {{store:import('./db.js').Store, publish:Function, detectors:Map}} deps
 */
export function createSimulation({ store, publish, detectors }) {
  let timer = null;
  let rand = mulberry32(0xc0ffee);
  let beatIndex = 0;
  let beatElapsedMs = 0;
  let tickCount = 0;
  let paused = false;
  let operatorActed = false;
  let startedAt = Date.now();

  /** Drowsiness alert latch, so the alert fires on the EDGE not every tick. */
  let wasDrowsy = false;

  const beat = () => BEATS[beatIndex];

  function state() {
    return {
      beatIndex,
      beatKey: beat().key,
      beatLabel: beat().label,
      beatCount: BEATS.length,
      beatElapsedMs,
      beatDurationMs: beat().durationMs,
      awaitsOperator: Boolean(beat().awaitsOperator) && !operatorActed,
      operatorActed,
      paused,
      tickCount,
      simClockMs: Date.now() - startedAt,
      tickMs: TICK_MS,
    };
  }

  function enterBeat(index, { viaOperator = false } = {}) {
    beatIndex = Math.min(Math.max(index, 0), BEATS.length - 1);
    beatElapsedMs = 0;
    operatorActed = false;
    publish(EVENTS.SCENARIO, { ...state(), viaOperator });
  }

  /** Nudge stop crowd counts toward the current beat's target. */
  function advanceCrowd(dtMs) {
    const target = beat().stopTarget;

    for (const stop of store.stops.all()) {
      const key = `crowd_${stop._id}`;
      const obs = store.crowd_observations.get(key);
      if (!obs) continue;

      // Only the focus stop follows the script; the rest breathe around their
      // seeded level so the dashboard doesn't look frozen.
      const isFocus = stop._id === FOCUS_STOP_ID;
      const aim = isFocus ? target : obs.count;
      const rate = isFocus ? 0.06 : 0.02;
      const noise = isFocus ? 0.5 : 1.1;

      // Latch read from the observation we are about to replace, using the
      // stop's CURRENT capacity — the identical derivation api/cv.js uses on
      // ingest. Keeping it in a Map here instead gave the two publishers
      // independent latches, so one physical crossing alerted twice: once from
      // the HTTP ingest and again on the next tick.
      const wasOver = isOvercrowded(occupancyPct(obs.count, stop.capacity));

      const next = Math.max(0, Math.round(ease(obs.count, aim, rate, noise, rand)));
      store.crowd_observations.put({
        ...obs,
        count: next,
        capacity: stop.capacity,
        source: 'simulation',
        observedAt: new Date().toISOString(),
      });

      // Edge-triggered overcrowding alert — this is the F1 -> F4 hand-off.
      const pct = occupancyPct(next, stop.capacity);
      if (isOvercrowded(pct) && !wasOver) {
        publish(EVENTS.ALERT, {
          kind: 'OVERCROWDING',
          severity: 'critical',
          stopId: stop._id,
          stopName: stop.name,
          count: next,
          capacity: stop.capacity,
          occupancyPct: pct,
          // Derived, never written as a literal, so this alert and the one
          // api/cv.js publishes can never recommend different things.
          recommendedAction: recommendedAction(pct),
          routeIds: store.routes.find((r) => r.stopIds.includes(stop._id)).map((r) => r._id),
          at: new Date().toISOString(),
        });
      }
    }
  }

  /** Move vehicles along their route polylines and jitter their speed. */
  function advanceVehicles(dtMs) {
    const dtHours = dtMs / 3_600_000;
    for (const v of store.vehicles.all()) {
      if (v.status !== 'in_service' || !v.routeId) continue;
      const rs = routeState(store, v.routeId);
      if (!rs || rs.distanceKm === 0) continue;

      const speed = Math.max(8, ease(v.speedKmph, 44, 0.05, 3.5, rand));
      const progress = (v.progress + (speed * dtHours) / rs.distanceKm) % 1;
      store.vehicles.update(v._id, {
        speedKmph: Math.round(speed * 10) / 10,
        progress: Math.round(progress * 10000) / 10000,
      });
    }
  }

  /** Walk the focus driver's EAR toward the beat target; others stay alert. */
  function advanceTelematics() {
    const now = new Date().toISOString();
    for (const t of store.telematics_current.all()) {
      const isFocus = t.vehicleId === FOCUS_VEHICLE_ID;
      const aim = isFocus ? beat().earTarget : 0.30;
      const vehicle = store.vehicles.get(t.vehicleId);

      const ear = Math.max(0.05, ease(t.earRatio, aim, isFocus ? 0.10 : 0.05, 0.008, rand));
      const harsh =
        isFocus && ear < EAR_THRESHOLD && rand() < 0.04
          ? t.harshBrakingEvents + 1
          : t.harshBrakingEvents;

      store.telematics_current.put({
        ...t,
        earRatio: Math.round(ear * 1000) / 1000,
        speedKmph: vehicle?.speedKmph ?? t.speedKmph,
        harshBrakingEvents: harsh,
        timestamp: now,
      });
    }

    // Derive the alert through the shared debounce so the panel and the alert
    // never disagree about whether the driver is drowsy.
    const view = telematicsView(store, FOCUS_VEHICLE_ID, detectors);
    if (view?.justTriggered && !wasDrowsy) {
      publish(EVENTS.ALERT, {
        kind: 'DROWSINESS',
        severity: 'critical',
        vehicleId: view.vehicleId,
        driverId: view.driverId,
        driverName: view.driverName,
        earRatio: view.earRatio,
        threshold: EAR_THRESHOLD,
        sustainedMs: view.closedMs,
        at: new Date().toISOString(),
      });
    }
    if (view) wasDrowsy = view.drowsinessFlag;
    return view;
  }

  /** Keep each route's demand consistent with the crowd at the stops it serves. */
  function recomputeDemand() {
    for (const route of store.routes.all()) {
      const stops = route.stopIds.map((id) => store.crowd_observations.get(`crowd_${id}`)).filter(Boolean);
      if (stops.length === 0) continue;

      const waiting = stops.reduce((s, o) => s + o.count, 0);
      const seats = store.vehicles
        .find((v) => v.routeId === route._id && v.status === 'in_service')
        .reduce((s, v) => s + v.capacity, 0);

      // Demand blends who is already aboard with who is still waiting.
      const onboard = store.vehicles
        .find((v) => v.routeId === route._id && v.status === 'in_service')
        .reduce((s, v) => s + v.onboard, 0);

      const demand = seats === 0 ? 100 : occupancyPct(onboard + waiting * 0.55, seats);
      store.routes.update(route._id, { currentDemand: Math.min(140, demand) });
    }
  }

  function tick() {
    if (paused) return;
    tickCount += 1;
    beatElapsedMs += TICK_MS;

    advanceCrowd(TICK_MS);
    advanceVehicles(TICK_MS);
    const telematics = advanceTelematics();
    recomputeDemand();

    const crowd = allStopCrowd(store);
    const fleet = fleetState(store);

    publish(EVENTS.CROWD, { stops: crowd, hottest: crowd[0] ?? null, tick: tickCount });
    publish(EVENTS.FLEET, {
      routes: fleet.routes.map((r) => ({
        routeId: r.routeId,
        routeName: r.routeName,
        currentDemand: r.currentDemand,
        congestionIndex: r.congestionIndex,
        stressBand: r.stressBand,
        overcrowded: r.overcrowded,
        seatCapacity: r.seatCapacity,
        onboard: r.onboard,
        seatsFree: r.seatsFree,
        headwayMins: r.headwayMins,
        distanceKm: r.distanceKm,
        vehicles: r.vehicles,
      })),
      idleVehicles: fleet.idleVehicles,
      totals: fleet.totals,
    });
    if (telematics) publish(EVENTS.TELEMATICS, telematics);

    // Beat progression.
    const d = beat().durationMs;
    if (d !== null && beatElapsedMs >= d) {
      if (beatIndex < BEATS.length - 1) enterBeat(beatIndex + 1);
    }
  }

  return {
    start() {
      if (timer) return;
      startedAt = Date.now();
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
      publish(EVENTS.SCENARIO, state());
    },
    stop() { clearInterval(timer); timer = null; },
    tick, // exposed so tests can advance the clock deterministically

    reset() {
      rand = mulberry32(0xc0ffee);
      beatIndex = 0;
      beatElapsedMs = 0;
      tickCount = 0;
      paused = false;
      operatorActed = false;
      startedAt = Date.now();
      wasDrowsy = false;
      publish(EVENTS.SCENARIO, state());
    },

    /** Jump straight to a beat — backs the 1-6 keyboard shortcuts. */
    jumpTo(index) { enterBeat(index, { viaOperator: true }); return state(); },
    next() { enterBeat(beatIndex + 1, { viaOperator: true }); return state(); },
    setPaused(v) { paused = Boolean(v); publish(EVENTS.SCENARIO, state()); return state(); },

    /**
     * Called by the re-route handler. Advances past the beat that was waiting on
     * the operator, so acting on the alert visibly moves the story forward.
     */
    onOperatorAction(kind) {
      operatorActed = true;
      if (beat().awaitsOperator) enterBeat(beatIndex + 1, { viaOperator: true });
      else publish(EVENTS.SCENARIO, { ...state(), operatorAction: kind });
      return state();
    },

    state,
    beats: BEATS,
  };
}
