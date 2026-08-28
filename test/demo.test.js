/**
 * The demo path itself.
 *
 * Every other suite tests a unit or an endpoint. This one tests the *90 seconds a
 * judge actually sees*, because that path runs across five panels and three
 * seed files and nothing else would catch it breaking. Each assertion here
 * corresponds to something visible on screen, and most of them guard a constant
 * that looks arbitrary in the seed data and is not: Central Station's capacity of
 * 22, BUS_108's 40 seats, the default origin and destination.
 *
 * The failure mode this exists to prevent is a silent one. Retune a capacity and
 * the crowd alert stops firing; change a stop's modes and the flagship
 * multi-modal itinerary quietly collapses into a single bus ride. Both still
 * return 200. Both would be discovered live.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { freshApp, get, post } from './harness.js';

/** The pair `web/js/journey.js` opens with. Kept in sync deliberately. */
const DEMO_FROM = 'ST_05';
const DEMO_TO = 'ST_06';

/** The stop the camera watches and the dispatch console acts on. */
const FOCUS_STOP = 'ST_01';

/** The idle bus the console dispatches, and the route it relieves. */
const SPARE_BUS = 'BUS_108';
const HOT_ROUTE = 'route_104';

describe('demo path', () => {
  let app;

  before(() => { app = freshApp(); });
  after(() => { app.sim.stop(); app.store.close(); });

  describe('seed constants the demo leans on', () => {
    it('gives Central Station a capacity that puts 19 waiting over the trigger', async () => {
      // 19/22 = 86.36%, just past the >85% dispatch threshold. This is the single
      // most load-bearing number in the seed: it is what makes the TRD's own
      // worked example reproduce, and it is one edit away from being 24 and
      // silently killing the alert that drives Feature 4.
      const { body } = await get(app, `/api/v1/cv/crowd-stream?stopId=${FOCUS_STOP}`);
      assert.equal(body.capacity, 22);
    });

    it('keeps a spare bus with exactly the 40 seats the TRD quotes', async () => {
      const { body } = await get(app, '/api/v1/fleet/state');
      const spare = body.idleVehicles?.find((v) => v.vehicleId === SPARE_BUS);
      assert.ok(spare, `${SPARE_BUS} must be idle and available to dispatch`);
      assert.equal(spare.capacity, 40);
    });
  });

  describe('the opening itinerary', () => {
    let plan;

    before(async () => {
      const res = await post(app, '/api/v1/journey/plan', {
        fromStopId: DEMO_FROM,
        toStopId: DEMO_TO,
      });
      assert.equal(res.status, 200);
      plan = res.body;
    });

    it('shows all three transit modes without anyone touching a control', () => {
      // The PRD's headline for Feature 3 is a multi-modal chain. A default pair
      // that produced one bus leg would satisfy the endpoint and lose the point
      // of the feature on the screen a judge sees first.
      const transit = plan.summary.modes.filter((m) => m !== 'walk');
      assert.deepEqual(transit.slice().sort(), ['bus', 'erickshaw', 'metro']);
      assert.equal(plan.summary.transfers, 2);
    });

    it('is bookended by walk legs, so the trip starts where the person is', () => {
      const first = plan.legs.at(0);
      const last = plan.legs.at(-1);
      assert.equal(first.mode, 'walk');
      assert.equal(first.fromStopId, null);
      assert.equal(last.mode, 'walk');
      assert.equal(last.toStopId, null);
    });

    it('transfers through the stop the rest of the console is about', () => {
      // Not a coincidence and not cosmetic: this is why the five panels read as
      // one system rather than five demos. If a seed change reroutes the default
      // itinerary away from Central Station the demo still works, but it stops
      // telling a single story, and that is worth being told about.
      const touched = new Set(plan.legs.flatMap((l) => [l.fromStopId, l.toStopId]));
      assert.ok(touched.has(FOCUS_STOP), `expected the itinerary to pass through ${FOCUS_STOP}`);
    });

    it('routes the e-rickshaw as a feeder onto the metro, not as a trunk haul', () => {
      // The feeder catchment is tested crow-flies and billed on road distance, so
      // a leg slightly over the 2 km constant is correct. What would be wrong is
      // an e-rickshaw carrying the longest leg of the journey.
      const erick = plan.legs.find((l) => l.mode === 'erickshaw');
      const longest = Math.max(...plan.legs.map((l) => l.distanceKm));
      assert.ok(erick.distanceKm < longest, 'the feeder must not be the longest leg');
      assert.ok(erick.distanceKm < 3, `feeder ran ${erick.distanceKm} km`);
    });
  });

  it('can plan every ordered pair of seeded stops', async () => {
    // A judge will click these selectors in whatever order they like. One
    // unreachable pair is a 422 on stage, so connectivity is asserted for all of
    // them rather than hoped for.
    const stops = (await get(app, '/api/v1/stops')).body.stops.map((s) => s.stopId);
    assert.equal(stops.length, 10);

    const broken = [];
    for (const fromStopId of stops) {
      for (const toStopId of stops) {
        if (fromStopId === toStopId) continue;
        // eslint-disable-next-line no-await-in-loop -- 90 in-process calls, ordered for a clear failure
        const res = await post(app, '/api/v1/journey/plan', { fromStopId, toStopId });
        if (res.status !== 200 || !res.body.legs?.length) {
          broken.push(`${fromStopId}->${toStopId} (${res.status} ${res.body?.error ?? ''})`);
        }
      }
    }
    assert.deepEqual(broken, [], `unplannable pairs: ${broken.join(', ')}`);
  });

  describe('the Feature 1 to Feature 4 chain', () => {
    // The centrepiece: a camera count becomes a dispatch recommendation becomes a
    // vehicle assignment becomes a measurable drop in demand. Each step is a
    // separate panel on screen, and this is the only test that walks the whole
    // chain in one go.
    let app2;

    before(() => { app2 = freshApp(); });
    after(() => { app2.sim.stop(); app2.store.close(); });

    it('turns 19 people on a platform into a dispatched bus and real relief', async () => {
      const ingest = await post(app2, '/api/v1/cv/ingest', {
        stopId: FOCUS_STOP,
        count: 19,
        groundTruth: 19,
        source: 'demo-test',
      });
      assert.equal(ingest.status, 200);

      // Feature 1's own readout, in the TRD's documented vocabulary.
      const stream = await get(app2, `/api/v1/cv/crowd-stream?stopId=${FOCUS_STOP}`);
      assert.equal(stream.body.currentCount, 19);
      assert.equal(stream.body.densityStatus, 'HIGH');
      assert.equal(stream.body.recommendedAction, 'DISPATCH_EXTRA_BUS');

      // Feature 4 acts on it.
      const before2 = (await get(app2, `/api/v1/routes/${HOT_ROUTE}`)).body.route;
      const reroute = await post(app2, '/api/v1/fleet/re-route', {
        vehicleId: SPARE_BUS,
        targetRouteId: HOT_ROUTE,
        requestId: 'demo-chain-1',
      });
      assert.equal(reroute.status, 200);
      assert.equal(reroute.body.success, true);
      assert.equal(reroute.body.updatedCapacityRelief, '40 Seats Added');
      assert.match(reroute.body.message, /BUS_108/);

      // And the relief is real, not a toast message.
      const after2 = (await get(app2, `/api/v1/routes/${HOT_ROUTE}`)).body.route;
      assert.ok(
        after2.currentDemand < before2.currentDemand,
        `demand ${before2.currentDemand} -> ${after2.currentDemand} should fall`,
      );
      assert.ok(after2.activeVehicles.includes(SPARE_BUS));
    });

    it('refuses to dispatch the same bus twice when the button is double-clicked', async () => {
      // An operator under pressure double-clicks. Without idempotency that is two
      // buses committed to one shortage and one bus stranded off its own route.
      const routeBefore = (await get(app2, `/api/v1/routes/${HOT_ROUTE}`)).body.route;

      const replay = await post(app2, '/api/v1/fleet/re-route', {
        vehicleId: SPARE_BUS,
        targetRouteId: HOT_ROUTE,
        requestId: 'demo-chain-1',
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replayed, true);

      const routeAfter = (await get(app2, `/api/v1/routes/${HOT_ROUTE}`)).body.route;
      assert.equal(routeAfter.currentDemand, routeBefore.currentDemand);
      assert.equal(
        routeAfter.activeVehicles.filter((v) => v === SPARE_BUS).length,
        1,
        'the spare bus must appear on the route exactly once',
      );
    });
  });
});
