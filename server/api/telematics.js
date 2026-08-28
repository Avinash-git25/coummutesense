/**
 * CommuteIQ — Feature 5: edge-AI driver telematics.
 *
 * ── Spec issues this module resolves ───────────────────────────────────────
 * The TRD's `telematics_logs` document persists `earRatio` AND `drowsinessFlag`
 * side by side. Storing a signal next to a conclusion drawn from it is a
 * contradiction waiting to happen: one write that updates the ratio without
 * recomputing the flag leaves the console showing a drowsy driver whose eyes are
 * open, or — far worse for a safety feature — an alert-looking driver who is
 * asleep. So no handler here reads or writes `drowsinessFlag`. It is derived on
 * every read by the shared DrowsinessDetector inside model.telematicsView, which
 * also supplies the sustained-closure debounce; the stored document holds only
 * the measurements an edge device can actually produce.
 *
 * The second gap is that the TRD describes telematics as read-only, without
 * saying where a sample comes from. A camera-based fatigue feature that cannot be
 * fed is undemonstrable, so `ingestTelematics` gives the edge device — and the
 * browser's EAR simulator, which stands in for it when there is no camera — one
 * POST to push a frame. Ingest and the scenario driver therefore travel the same
 * code path, and the panel behaves identically whichever is driving it.
 *
 * Note on ordering: the detector is stateful and advances on every read, so each
 * handler calls telematicsView AT MOST ONCE per vehicle per request. Calling it
 * twice would double-count the interval since the last sample and let the
 * closure clock run ahead of the wall clock.
 */

import { EVENTS } from '../bus.js';
import { EAR_THRESHOLD } from '../domain.js';
import { telematicsView } from '../model.js';
import { badRequest, notFound } from '../http-error.js';

/**
 * Plausibility ceiling for an ingested road speed, km/h. Not a domain threshold —
 * nothing behavioural hangs off it. It only rejects samples a city bus could not
 * have produced, so a decimal-point slip cannot poison the stability score.
 */
const MAX_INGEST_SPEED_KMPH = 150;

/** An Eye Aspect Ratio is a ratio, so anything outside 0..1 is a broken sample. */
const EAR_MIN = 0;
const EAR_MAX = 1;

const round1 = (n) => Math.round(n * 10) / 10;

/** A JSON client that omits a field may send `null`; both mean "not supplied". */
const supplied = (v) => v !== undefined && v !== null;

/**
 * Validate one numeric telemetry field.
 * @param {unknown} value
 * @param {string} name field name, echoed to the client
 * @param {{min:number, max?:number, integer?:boolean}} bounds
 * @returns {number}
 */
function numberField(value, name, { min, max, integer = false }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest(`${name} must be a finite number`, { field: name });
  }
  if (integer && !Number.isInteger(value)) {
    throw badRequest(`${name} must be a whole number`, { field: name, value });
  }
  if (value < min) {
    throw badRequest(`${name} must be at least ${min}`, { field: name, value });
  }
  if (max !== undefined && value > max) {
    throw badRequest(`${name} must not exceed ${max}`, { field: name, value });
  }
  return value;
}

/**
 * Resolve the live telematics document for a vehicle, or explain which of the two
 * ways it can be missing applies. Both are 404s, but they mean different things
 * to whoever is holding the edge device: a typo'd id versus a real vehicle with
 * nobody in the cab (BUS_112 is in maintenance and has no driver, so it has no
 * stream to push to).
 * @param {import('../db.js').Store} store
 * @param {string} vehicleId
 */
function requireTelematicsDoc(store, vehicleId) {
  const doc = store.telematics_current.get(`telematics_${vehicleId}`);
  if (doc) return doc;
  if (!store.vehicles.get(vehicleId)) throw notFound(`unknown vehicle: ${vehicleId}`);
  throw notFound(`${vehicleId} has no telematics stream — the vehicle is uncrewed`, {
    vehicleId,
  });
}

/** @param {unknown} value @returns {string} a validated, trimmed vehicle id */
function requireVehicleId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('vehicleId is required');
  }
  return value.trim();
}

/**
 * GET /api/v1/telematics/:vehicleId — live driver state for one vehicle.
 *
 * `drowsinessFlag` in the response is DERIVED by the shared DrowsinessDetector
 * rather than read from storage. The TRD persists both `earRatio` and
 * `drowsinessFlag`, which lets the two contradict each other; deriving the flag
 * from the ratio at read time makes that impossible by construction.
 */
export async function getTelematics(ctx) {
  const { store, params, detectors } = ctx;
  const vehicleId = requireVehicleId(params?.vehicleId);

  const view = telematicsView(store, vehicleId, detectors);
  if (!view) {
    // Distinguish a bad id from an uncrewed vehicle; both are 404.
    requireTelematicsDoc(store, vehicleId);
    throw notFound(`no telematics for ${vehicleId}`);
  }

  return {
    success: true,
    telematics: view,
    threshold: EAR_THRESHOLD,
  };
}

/**
 * GET /api/v1/telematics — every crewed vehicle, worst driver first.
 *
 * Ordered by ascending stabilityScore because the operator's question is always
 * "who needs attention", never "who is fine". Ties break on vehicleId so the
 * list does not reshuffle between polls.
 */
export async function listTelematics(ctx) {
  const { store, detectors } = ctx;

  const fleet = store.telematics_current
    .all()
    .map((t) => telematicsView(store, t.vehicleId, detectors))
    .filter(Boolean)
    .sort((a, b) => a.stabilityScore - b.stabilityScore
      || a.vehicleId.localeCompare(b.vehicleId));

  const harshBrakingTotal = fleet.reduce((sum, v) => sum + (v.harshBrakingEvents ?? 0), 0);
  const stabilityTotal = fleet.reduce((sum, v) => sum + v.stabilityScore, 0);

  return {
    success: true,
    fleet,
    summary: {
      fleetSize: fleet.length,
      drowsyCount: fleet.filter((v) => v.drowsinessFlag).length,
      // Guarded division: an empty fleet is a legitimate state after a reset.
      avgStabilityScore: fleet.length === 0 ? 0 : round1(stabilityTotal / fleet.length),
      harshBrakingTotal,
    },
    threshold: EAR_THRESHOLD,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * POST /api/v1/telematics/ingest — accept one telemetry frame from the cab.
 *
 * Body: { vehicleId, earRatio?, speedKmph?, harshBrakingEvents?, hoursOnDuty? }
 *
 * Every measurement is optional so a device can report only the sensors it has;
 * the EAR simulator in the browser, for instance, pushes nothing but `earRatio`.
 * Fields are copied across one at a time from an allow-list rather than spread
 * from the body, which is what guarantees a client cannot smuggle in a
 * `drowsinessFlag` (or any other derived value) and desynchronise the read model.
 */
export async function ingestTelematics(ctx) {
  const { store, body, publish, detectors } = ctx;
  const payload = body ?? {};
  const vehicleId = requireVehicleId(payload.vehicleId);
  const existing = requireTelematicsDoc(store, vehicleId);

  const patch = {};
  if (supplied(payload.earRatio)) {
    patch.earRatio = numberField(payload.earRatio, 'earRatio', { min: EAR_MIN, max: EAR_MAX });
  }
  if (supplied(payload.speedKmph)) {
    patch.speedKmph = numberField(payload.speedKmph, 'speedKmph', {
      min: 0, max: MAX_INGEST_SPEED_KMPH,
    });
  }
  if (supplied(payload.harshBrakingEvents)) {
    patch.harshBrakingEvents = numberField(payload.harshBrakingEvents, 'harshBrakingEvents', {
      min: 0, integer: true,
    });
  }
  if (supplied(payload.hoursOnDuty)) {
    patch.hoursOnDuty = numberField(payload.hoursOnDuty, 'hoursOnDuty', { min: 0 });
  }

  // The timestamp always moves, even for a frame that carries no new readings:
  // "this device is still reporting" is itself information the console shows, and
  // a stale timestamp on a live stream reads as a dropped link.
  const at = new Date().toISOString();
  store.telematics_current.put({ ...existing, ...patch, timestamp: at });

  // Single read, so the detector sees exactly one sample for this frame.
  const view = telematicsView(store, vehicleId, detectors);
  publish(EVENTS.TELEMATICS, view);

  // Rising edge only. `justTriggered` is already the edge — the detector flipped
  // from not-alerting to alerting on this very sample — so a second latch here
  // would only add a way for the two to disagree.
  const alerted = Boolean(view?.justTriggered);
  if (alerted) {
    publish(EVENTS.ALERT, {
      kind: 'DROWSINESS',
      severity: 'critical',
      vehicleId: view.vehicleId,
      driverId: view.driverId,
      driverName: view.driverName,
      earRatio: view.earRatio,
      threshold: EAR_THRESHOLD,
      sustainedMs: view.closedMs,
      at,
    });
  }

  return { success: true, telematics: view, alerted };
}
