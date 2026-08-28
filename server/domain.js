/**
 * CommuteIQ — domain rules.
 *
 * SINGLE SOURCE OF TRUTH for every threshold, band and derived metric in the
 * system. Nothing else in the codebase is allowed to hardcode a threshold.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The PRD specifies crowding twice, in two incompatible units:
 *
 *   Feature 1 (CV tracker):  Low (<5), Moderate (5-15), High (>15)   — a COUNT
 *   Feature 4 (Fleet):       overcrowding triggers at >85%            — a RATIO
 *
 * A raw count cannot trigger a percentage rule, so the F1 -> F4 dispatch chain
 * had no defined trigger. We bridge them by giving every stop and vehicle a
 * `capacity`, then deriving occupancy:
 *
 *   occupancyPct = count / capacity * 100
 *
 * Count bands stay the human-facing STOP label (what F1 renders).
 * Occupancy bands drive FLEET ACTIONS (what F4 reacts to).
 *
 * Worked example — the exact case in the TRD:
 *   Central Station (ST_01), capacity 22, currentCount 19
 *     -> classifyCount(19)        = 'HIGH'              (19 >= 16)
 *     -> occupancyPct(19, 22)     = 86.36%
 *     -> classifyOccupancy(86.36) = 'CRITICAL'          (> 85)
 *     -> recommendedAction(...)   = 'DISPATCH_EXTRA_BUS'
 *   which reproduces the TRD's documented response exactly.
 */

// ── Feature 1: stop-level crowd count bands (PRD verbatim) ──────────────────

/** Inclusive upper bound of the LOW band. PRD: "Low (<5)". */
export const COUNT_LOW_MAX = 4;
/** Inclusive upper bound of the MODERATE band. PRD: "Moderate (5-15)". */
export const COUNT_MODERATE_MAX = 15;

/**
 * Human-facing crowd label for a stop, by absolute head count.
 * @param {number} count
 * @returns {'LOW'|'MODERATE'|'HIGH'}
 */
export function classifyCount(count) {
  const n = toFiniteNonNegative(count, 'count');
  if (n <= COUNT_LOW_MAX) return 'LOW';
  if (n <= COUNT_MODERATE_MAX) return 'MODERATE';
  return 'HIGH';
}

// ── Feature 4: occupancy bands that drive fleet actions ─────────────────────

/** Above this occupancy percentage a stop/route counts as overcrowded (PRD F4: ">85%"). */
export const CRITICAL_OCCUPANCY_PCT = 85;
export const HIGH_OCCUPANCY_PCT = 70;
export const ELEVATED_OCCUPANCY_PCT = 40;

/**
 * @param {number} count   people observed
 * @param {number} capacity  designed capacity of the stop or vehicle
 * @returns {number} occupancy percentage, rounded to 2dp. Can exceed 100.
 */
export function occupancyPct(count, capacity) {
  const n = toFiniteNonNegative(count, 'count');
  const cap = toFiniteNonNegative(capacity, 'capacity');
  if (cap === 0) return 0;
  return round2((n / cap) * 100);
}

/**
 * @param {number} pct occupancy percentage
 * @returns {'NOMINAL'|'ELEVATED'|'HIGH'|'CRITICAL'}
 */
export function classifyOccupancy(pct) {
  const p = toFiniteNonNegative(pct, 'pct');
  if (p > CRITICAL_OCCUPANCY_PCT) return 'CRITICAL';
  if (p >= HIGH_OCCUPANCY_PCT) return 'HIGH';
  if (p >= ELEVATED_OCCUPANCY_PCT) return 'ELEVATED';
  return 'NOMINAL';
}

/** True when occupancy has crossed the PRD's >85% overcrowding trigger. */
export function isOvercrowded(pct) {
  return toFiniteNonNegative(pct, 'pct') > CRITICAL_OCCUPANCY_PCT;
}

/**
 * The operational recommendation surfaced by GET /api/v1/cv/crowd-stream.
 * @param {number} pct occupancy percentage
 * @returns {'NONE'|'MONITOR'|'PREPARE_DISPATCH'|'DISPATCH_EXTRA_BUS'}
 */
export function recommendedAction(pct) {
  switch (classifyOccupancy(pct)) {
    case 'CRITICAL': return 'DISPATCH_EXTRA_BUS';
    case 'HIGH':     return 'PREPARE_DISPATCH';
    case 'ELEVATED': return 'MONITOR';
    default:         return 'NONE';
  }
}

/**
 * The TRD stores `congestionIndex: "High"` alongside `currentDemand: 88`.
 * Storing both guarantees they drift apart, so we derive it at read time and
 * never persist it.
 * @param {number} demandPct route demand percentage
 * @returns {'Low'|'Moderate'|'High'|'Critical'}
 */
export function congestionIndex(demandPct) {
  switch (classifyOccupancy(demandPct)) {
    case 'CRITICAL': return 'Critical';
    case 'HIGH':     return 'High';
    case 'ELEVATED': return 'Moderate';
    default:         return 'Low';
  }
}

/**
 * Seats freed by moving a vehicle onto a demand-heavy route.
 *
 * The TRD hardcodes the string "40 Seats Added". We compute it from the
 * vehicle's own capacity and return a number so the UI can do arithmetic.
 * @param {{capacity:number, onboard?:number}} vehicle
 * @returns {{seatsAdded:number, unit:'seats', text:string}}
 */
export function capacityRelief(vehicle) {
  const cap = toFiniteNonNegative(vehicle?.capacity, 'vehicle.capacity');
  const onboard = toFiniteNonNegative(vehicle?.onboard ?? 0, 'vehicle.onboard');
  const seatsAdded = Math.max(0, Math.round(cap - onboard));
  return { seatsAdded, unit: 'seats', text: `${seatsAdded} Seats Added` };
}

/**
 * Route demand after `seatsAdded` extra seats arrive.
 * @param {number} currentDemandPct
 * @param {number} routeCapacityBefore total seats already serving the route
 * @param {number} seatsAdded
 * @returns {number} new demand percentage, 2dp
 */
export function demandAfterRelief(currentDemandPct, routeCapacityBefore, seatsAdded) {
  const demand = toFiniteNonNegative(currentDemandPct, 'currentDemandPct');
  const before = toFiniteNonNegative(routeCapacityBefore, 'routeCapacityBefore');
  const added = toFiniteNonNegative(seatsAdded, 'seatsAdded');
  if (before + added === 0) return 0;
  // Riders are fixed; only supply grows. demand% = riders / seats.
  const riders = (demand / 100) * before;
  return round2((riders / (before + added)) * 100);
}

// ── Feature 5: driver fatigue (Eye Aspect Ratio) ────────────────────────────

/**
 * EAR below this is an eyes-closed frame. Standard published EAR thresholds sit
 * in the 0.20-0.25 range; the TRD's sample reading of 0.18 is comfortably below.
 */
export const EAR_THRESHOLD = 0.21;

/**
 * Continuous eye closure required before alerting, in milliseconds.
 *
 * This is the substance of Feature 5. A bare `earRatio < threshold` check fires
 * on every blink — a blink lasts 100-400ms — which would make the alert useless
 * noise. Published drowsiness work (PERCLOS, and EAR-based microsleep detection)
 * puts the blink/microsleep boundary near half a second, with practical alerting
 * around 1.5-2s of sustained closure. We use 2s.
 *
 * Deliberately expressed as TIME, not a frame count: the same detector runs at
 * the server's 250ms telemetry rate and in the browser at ~60fps display rate,
 * and a frame count would mean something different in each.
 */
export const EAR_SUSTAINED_MS = 2000;

/**
 * Stateful debounce for the drowsiness alert. The TRD persists both `earRatio`
 * and `drowsinessFlag`; we keep only the signal and derive the flag here, so the
 * two can never contradict each other.
 */
export class DrowsinessDetector {
  #closedMs = 0;
  #samples = 0;
  #lastAt = null;
  #alerting = false;

  /**
   * @param {number} ear current Eye Aspect Ratio
   * @param {number} [nowMs] sample timestamp; defaults to wall clock
   * @returns {{drowsy:boolean, closedMs:number, closedSamples:number, justTriggered:boolean, progressPct:number}}
   */
  push(ear, nowMs = Date.now()) {
    const wasAlerting = this.#alerting;
    // First sample has no measurable interval; assume one server tick.
    const dt = this.#lastAt === null ? 0 : Math.max(0, nowMs - this.#lastAt);
    this.#lastAt = nowMs;

    if (Number.isFinite(ear) && ear < EAR_THRESHOLD) {
      this.#closedMs += dt;
      this.#samples += 1;
    } else {
      this.#closedMs = 0;
      this.#samples = 0;
    }

    this.#alerting = this.#closedMs >= EAR_SUSTAINED_MS;
    return {
      drowsy: this.#alerting,
      closedMs: this.#closedMs,
      closedSamples: this.#samples,
      justTriggered: this.#alerting && !wasAlerting,
      progressPct: Math.min(100, round1((this.#closedMs / EAR_SUSTAINED_MS) * 100)),
    };
  }

  reset() { this.#closedMs = 0; this.#samples = 0; this.#lastAt = null; this.#alerting = false; }
}

/**
 * Composite driver safety score from telematics, 0-100.
 * @param {{speedKmph:number, harshBrakingEvents:number, hoursOnDuty:number, earRatio:number}} m
 */
export function stabilityScore({ speedKmph = 0, harshBrakingEvents = 0, hoursOnDuty = 0, earRatio = 0.3 }) {
  let score = 100;
  score -= Math.max(0, speedKmph - 60) * 1.2;        // speeding over 60km/h
  score -= harshBrakingEvents * 4;                   // each harsh brake
  score -= Math.max(0, hoursOnDuty - 6) * 5;         // fatigue past a 6h shift
  score -= Math.max(0, (EAR_THRESHOLD - earRatio)) * 100; // sustained eye closure
  return Math.round(Math.min(100, Math.max(0, score)));
}

// ── Feature 2: explainable ETA model ───────────────────────────────────────

/** Average in-city bus speed, km/h, used for the base leg time. */
export const BASE_SPEED_KMPH = 22;
/** Minutes added per unit of signal congestion score (0-1). */
export const SIGNAL_DELAY_WEIGHT = 6;
/** Minutes of extra dwell per 10% of stop occupancy, from slower boarding. */
export const DWELL_PER_10PCT = 0.35;

/** Weather penalty in minutes. */
export const WEATHER_PENALTY = {
  clear: 0,
  cloudy: 0.4,
  rain: 2.1,
  heavy_rain: 4.8,
};

/** Peak-hour multiplier by ISO day of week (1 = Monday .. 7 = Sunday). */
export const DAY_OF_WEEK_FACTOR = {
  1: 1.15, 2: 1.08, 3: 1.06, 4: 1.09, 5: 1.18, 6: 0.92, 7: 0.78,
};

/**
 * Additive, fully explainable ETA. Deliberately not a black box: the caller
 * gets the per-factor contribution so the UI can show how the number was built.
 *
 * @param {object} p
 * @param {number} p.distanceKm
 * @param {number} p.signalCongestionScore 0-1
 * @param {number} p.stopOccupancyPct
 * @param {keyof typeof WEATHER_PENALTY} p.weather
 * @param {number} p.isoDayOfWeek 1-7
 * @returns {{etaMins:number, breakdown:Array<{label:string, mins:number}>, confidencePct:number}}
 */
export function estimateEta({
  distanceKm,
  signalCongestionScore = 0,
  stopOccupancyPct = 0,
  weather = 'clear',
  isoDayOfWeek = 1,
}) {
  const km = toFiniteNonNegative(distanceKm, 'distanceKm');
  const base = (km / BASE_SPEED_KMPH) * 60;
  const dayFactor = DAY_OF_WEEK_FACTOR[isoDayOfWeek] ?? 1;

  const traffic = base * (dayFactor - 1) + signalCongestionScore * SIGNAL_DELAY_WEIGHT;
  const weatherMins = WEATHER_PENALTY[weather] ?? 0;
  const dwell = (stopOccupancyPct / 10) * DWELL_PER_10PCT;

  const breakdown = [
    { label: 'Base travel time', mins: round1(base) },
    { label: 'Traffic & signals', mins: round1(traffic) },
    { label: 'Weather', mins: round1(weatherMins) },
    { label: 'Boarding dwell', mins: round1(dwell) },
  ];
  const etaMins = round1(base + traffic + weatherMins + dwell);

  // Confidence degrades as the unmodelled share of the estimate grows.
  const variablePart = Math.abs(traffic) + weatherMins + dwell;
  const confidencePct = Math.round(Math.max(55, 96 - (variablePart / Math.max(base, 1)) * 45));

  return { etaMins, breakdown, confidencePct };
}

// ── Feature 3: fare, distance, carbon ──────────────────────────────────────

/** Per-mode fare: flat boarding charge plus a per-km rate, in INR. */
export const FARE_TABLE = {
  walk:      { base: 0,  perKm: 0 },
  bus:       { base: 8,  perKm: 1.6 },
  metro:     { base: 10, perKm: 2.4 },
  erickshaw: { base: 15, perKm: 6.0 },
};

/** grams CO2 per passenger-km. `car` is the baseline we compare savings against. */
export const CO2_G_PER_PKM = {
  walk: 0, bus: 68, metro: 33, erickshaw: 42, car: 171,
};

/** @param {keyof typeof FARE_TABLE} mode @param {number} km */
export function legFare(mode, km) {
  const t = FARE_TABLE[mode];
  if (!t) throw new Error(`unknown mode: ${mode}`);
  return round2(t.base + t.perKm * toFiniteNonNegative(km, 'km'));
}

/**
 * Concession multipliers applied to the whole-journey fare.
 *
 * Lives here rather than in pass.js because two callers need it and they must
 * not be able to disagree: the planner quotes a fare in the itinerary panel, and
 * the pass endpoint charges one. A student who is quoted ₹9.50 and then issued a
 * ticket for ₹19 has found a bug, and the only way to be sure that cannot happen
 * is for both numbers to come out of the same table.
 */
export const FARE_MULTIPLIER = { adult: 1, student: 0.5, senior: 0.5, child: 0.35 };

/**
 * @param {number} totalFare
 * @param {string} passengerType
 * @returns {{passengerType:string, fareMultiplier:number, payableFare:number}}
 * @throws when the type is unknown — callers validate first and surface a 400.
 */
export function concessionFare(totalFare, passengerType = 'adult') {
  // Own-property test, not `in`: every object inherits `toString`, so `in` would
  // accept passengerType='toString' and then multiply the fare by a function,
  // pricing the journey at NaN.
  if (!Object.hasOwn(FARE_MULTIPLIER, passengerType)) {
    throw new Error(`unknown passengerType: ${passengerType}`);
  }
  const fareMultiplier = FARE_MULTIPLIER[passengerType];
  return {
    passengerType,
    fareMultiplier,
    payableFare: round2(toFiniteNonNegative(totalFare, 'totalFare') * fareMultiplier),
  };
}

/**
 * CO2 avoided versus making the same trip by private car.
 * @param {Array<{mode:string, distanceKm:number}>} legs
 * @returns {{gramsUsed:number, gramsIfCar:number, gramsSaved:number, kgSaved:number}}
 */
export function carbonSaved(legs) {
  let gramsUsed = 0;
  let totalKm = 0;
  for (const leg of legs) {
    const km = toFiniteNonNegative(leg.distanceKm, 'leg.distanceKm');
    gramsUsed += (CO2_G_PER_PKM[leg.mode] ?? 0) * km;
    totalKm += km;
  }
  const gramsIfCar = CO2_G_PER_PKM.car * totalKm;
  const gramsSaved = Math.max(0, gramsIfCar - gramsUsed);
  return {
    gramsUsed: round2(gramsUsed),
    gramsIfCar: round2(gramsIfCar),
    gramsSaved: round2(gramsSaved),
    kgSaved: round2(gramsSaved / 1000),
  };
}

// ── Geo ─────────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance between two lat/lng points, in km.
 * @returns {number} km, 3dp
 */
export function haversineKm(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return round3(2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h)));
}

/**
 * Road distance estimate. Straight-line distance understates street networks;
 * 1.32 is a commonly used detour index for dense Indian urban grids.
 */
export const DETOUR_INDEX = 1.32;

export function roadDistanceKm(aLat, aLng, bLat, bLng) {
  return round3(haversineKm(aLat, aLng, bLat, bLng) * DETOUR_INDEX);
}

// ── helpers ────────────────────────────────────────────────────────────────

function toFiniteNonNegative(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be a finite number, got ${v}`);
  return n < 0 ? 0 : n;
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
