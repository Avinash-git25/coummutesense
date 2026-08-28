/**
 * CommuteIQ — seeding.
 *
 * Loads `data/seed/*.json` into the store on every boot. Idempotent, because
 * `Collection.put` is INSERT OR REPLACE — so re-seeding is also how the demo
 * reset control returns the city to its documented starting state.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EAR_THRESHOLD } from './domain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SEED_DIR = join(HERE, '..', 'data', 'seed');
export const PROJECT_ROOT = join(HERE, '..');

/** @param {string} name file name inside data/seed */
function loadJson(name) {
  const path = join(SEED_DIR, name);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`failed to load seed file ${path}: ${err.message}`);
  }
}

/**
 * Initial crowd counts per stop. Chosen so the city starts in a plausible
 * mid-morning state and ST_01 sits just below the overcrowding trigger — the
 * scenario driver pushes it over, rather than starting there.
 */
export const INITIAL_STOP_COUNTS = {
  ST_01: 12, ST_02: 7, ST_03: 9, ST_04: 11, ST_05: 3,
  ST_06: 8, ST_07: 5, ST_08: 4, ST_09: 14, ST_10: 6,
};

/**
 * Populate every collection from the seed files.
 * @param {import('./db.js').Store} store
 * @returns {{routes:number, stops:number, vehicles:number, drivers:number}}
 */
export function seed(store) {
  store.clearAll();

  const routes = loadJson('routes.json');
  const stops = loadJson('stops.json');
  const vehicles = loadJson('vehicles.json');
  const drivers = loadJson('drivers.json');

  store.routes.putMany(routes);
  store.stops.putMany(stops);
  store.vehicles.putMany(vehicles);
  store.drivers.putMany(drivers);

  // Opening crowd observation for each stop.
  const observedAt = new Date().toISOString();
  for (const stop of stops) {
    store.crowd_observations.put({
      _id: `crowd_${stop._id}`,
      stopId: stop._id,
      count: INITIAL_STOP_COUNTS[stop._id] ?? 0,
      capacity: stop.capacity,
      source: 'seed',
      observedAt,
    });
  }

  // Live telematics state for every crewed, in-service vehicle.
  // NOTE: `drowsinessFlag` is deliberately NOT stored — it is derived from
  // earRatio by DrowsinessDetector so the two can never disagree.
  for (const v of vehicles) {
    if (!v.driverId) continue;
    const driver = drivers.find((d) => d._id === v.driverId);
    store.telematics_current.put({
      _id: `telematics_${v._id}`,
      vehicleId: v._id,
      driverId: v.driverId,
      speedKmph: v.speedKmph ?? 0,
      harshBrakingEvents: v._id === 'BUS_101' ? 2 : 0,
      // DRV_882 is 7.5h into a shift — the scenario walks this driver's EAR down.
      earRatio: v.driverId === 'DRV_882' ? 0.24 : 0.31,
      hoursOnDuty: driver?.hoursOnDuty ?? 0,
      timestamp: observedAt,
    });
  }

  return {
    routes: store.routes.size,
    stops: store.stops.size,
    vehicles: store.vehicles.size,
    drivers: store.drivers.size,
  };
}

/** Sanity floor: EAR seeds must sit above the alert threshold at boot. */
export function assertSeedSanity(store) {
  for (const t of store.telematics_current.all()) {
    if (t.earRatio < EAR_THRESHOLD) {
      throw new Error(`seed for ${t.vehicleId} starts below the EAR alert threshold`);
    }
  }
}
