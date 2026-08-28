/**
 * Domain rules — the numbers the whole prototype hangs off.
 *
 * These are the assertions worth having: every one of them is a claim the demo
 * makes out loud, and most of them encode a decision where the PRD and TRD were
 * ambiguous. The TRD's worked example is tested literally, because "19 waiting at
 * Central Station means DISPATCH_EXTRA_BUS" is the sentence the console has to be
 * able to justify.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CRITICAL_OCCUPANCY_PCT,
  DrowsinessDetector,
  EAR_SUSTAINED_MS,
  EAR_THRESHOLD,
  FARE_MULTIPLIER,
  WEATHER_PENALTY,
  capacityRelief,
  carbonSaved,
  classifyCount,
  classifyOccupancy,
  concessionFare,
  congestionIndex,
  demandAfterRelief,
  estimateEta,
  haversineKm,
  isOvercrowded,
  legFare,
  occupancyPct,
  recommendedAction,
  roadDistanceKm,
  stabilityScore,
} from '../server/domain.js';

describe('crowd classification', () => {
  it('uses the PRD bands: Low <5, Moderate 5-15, High >15', () => {
    assert.equal(classifyCount(0), 'LOW');
    assert.equal(classifyCount(4), 'LOW');
    assert.equal(classifyCount(5), 'MODERATE');
    assert.equal(classifyCount(15), 'MODERATE');
    assert.equal(classifyCount(16), 'HIGH');
  });

  it("reproduces the TRD's worked example exactly", () => {
    // GET /api/v1/cv/crowd-stream documents currentCount 19 -> HIGH ->
    // DISPATCH_EXTRA_BUS. Central Station's seeded capacity of 22 is what makes
    // 19 land above the 85% trigger, so this test is also guarding that number.
    const count = 19;
    const capacity = 22;
    assert.equal(classifyCount(count), 'HIGH');

    const pct = occupancyPct(count, capacity);
    assert.equal(pct, 86.36);
    assert.ok(pct > CRITICAL_OCCUPANCY_PCT, `${pct}% must exceed ${CRITICAL_OCCUPANCY_PCT}%`);
    assert.equal(classifyOccupancy(pct), 'CRITICAL');
    assert.equal(isOvercrowded(pct), true);
    // recommendedAction takes a PERCENTAGE, not a count — the whole point of the
    // count/ratio bridge is that the action is driven by occupancy.
    assert.equal(recommendedAction(pct), 'DISPATCH_EXTRA_BUS');
  });

  it('does not trigger dispatch just below the line', () => {
    // 18/22 = 81.8%: still HIGH by headcount, but under the percentage trigger.
    // This is the pair of scales the PRD left unreconciled, so it is worth
    // pinning: a high count is not by itself an instruction to dispatch.
    assert.equal(classifyCount(18), 'HIGH');
    const pct = occupancyPct(18, 22);
    assert.equal(isOvercrowded(pct), false);
    assert.equal(recommendedAction(pct), 'PREPARE_DISPATCH');
  });

  it('maps every occupancy band to an action', () => {
    assert.equal(recommendedAction(10), 'NONE');
    assert.equal(recommendedAction(50), 'MONITOR');
    assert.equal(recommendedAction(75), 'PREPARE_DISPATCH');
    assert.equal(recommendedAction(90), 'DISPATCH_EXTRA_BUS');
  });

  it('treats a zero capacity as 0% rather than dividing by zero', () => {
    assert.equal(occupancyPct(5, 0), 0);
    assert.ok(Number.isFinite(occupancyPct(0, 0)));
  });
});

describe('congestion index', () => {
  it('labels a demand of 88 Critical, deviating from the TRD deliberately', () => {
    // The TRD's routes schema shows currentDemand 88 with congestionLevel "High".
    // We call 88 Critical, because 88% is past the >85% threshold the same
    // document uses to trigger a dispatch — a load that demands action should not
    // share a label with one that only warrants watching. Documented in README.
    assert.equal(congestionIndex(88), 'Critical');
    assert.equal(congestionIndex(85), 'High');
    assert.equal(congestionIndex(50), 'Moderate');
    assert.equal(congestionIndex(10), 'Low');
  });
});

describe('capacity relief', () => {
  it("computes the TRD's '40 Seats Added' from the vehicle instead of hardcoding it", () => {
    const relief = capacityRelief({ capacity: 40 });
    assert.equal(relief.seatsAdded, 40);
    assert.equal(relief.text, '40 Seats Added');
  });

  it('scales with the vehicle actually dispatched', () => {
    assert.equal(capacityRelief({ capacity: 32 }).text, '32 Seats Added');
  });

  it('lowers demand and never below zero', () => {
    const after = demandAfterRelief(88, 200, 40);
    assert.ok(after < 88, `expected relief, got ${after}`);
    assert.ok(after >= 0);

    // Relief is asymptotic, not subtractive: riders are fixed and only supply
    // grows, so a huge injection drives demand toward zero without reaching it.
    // Asserting exactly 0 here would be asserting the wrong model.
    const flooded = demandAfterRelief(5, 10, 1000);
    assert.ok(flooded > 0 && flooded < 0.1, `got ${flooded}`);
    assert.equal(demandAfterRelief(50, 0, 0), 0);
  });

  it('is monotonic in seats added', () => {
    const steps = [0, 20, 40, 80].map((s) => demandAfterRelief(88, 200, s));
    for (let i = 1; i < steps.length; i += 1) {
      assert.ok(steps[i] < steps[i - 1], `${steps[i - 1]} -> ${steps[i]} not decreasing`);
    }
  });
});

describe('drowsiness detection', () => {
  it('ignores a blink', () => {
    const d = new DrowsinessDetector();
    // 200 ms below threshold is a blink, an order of magnitude short of the
    // 2000 ms sustained-closure rule.
    let last = null;
    for (let t = 0; t <= 200; t += 50) last = d.push(0.12, t);
    assert.equal(last.drowsy, false);
    assert.ok(last.closedMs <= 250, `closedMs was ${last.closedMs}`);
  });

  it('fires once the closure is sustained, and only on the rising edge', () => {
    const d = new DrowsinessDetector();
    let triggers = 0;
    let drowsyAt = null;
    for (let t = 0; t <= EAR_SUSTAINED_MS + 500; t += 100) {
      const r = d.push(0.12, t);
      if (r.justTriggered) { triggers += 1; drowsyAt = t; }
    }
    assert.equal(triggers, 1, 'justTriggered must be an edge, not a level');
    assert.ok(drowsyAt >= EAR_SUSTAINED_MS, `fired early at ${drowsyAt} ms`);
  });

  it('clears when the eyes reopen', () => {
    const d = new DrowsinessDetector();
    for (let t = 0; t <= EAR_SUSTAINED_MS + 200; t += 100) d.push(0.12, t);
    const open = d.push(0.31, EAR_SUSTAINED_MS + 400);
    assert.equal(open.drowsy, false);
    assert.equal(open.closedMs, 0);
    assert.equal(open.progressPct, 0);
  });

  it('reports progress monotonically while the eyes stay shut', () => {
    const d = new DrowsinessDetector();
    let prev = -1;
    for (let t = 0; t <= EAR_SUSTAINED_MS; t += 200) {
      const { progressPct } = d.push(EAR_THRESHOLD - 0.01, t);
      assert.ok(progressPct >= prev, `progress went backwards: ${prev} -> ${progressPct}`);
      assert.ok(progressPct <= 100);
      prev = progressPct;
    }
    assert.equal(prev, 100);
  });
});

describe('stability score', () => {
  it('stays inside 0..100 under abusive input', () => {
    const worst = stabilityScore({
      speedKmph: 400, harshBrakingEvents: 99, hoursOnDuty: 40, earRatio: 0,
    });
    assert.equal(worst, 0);
    const best = stabilityScore({
      speedKmph: 30, harshBrakingEvents: 0, hoursOnDuty: 1, earRatio: 0.32,
    });
    assert.equal(best, 100);
  });

  it('penalises the seeded fatigue driver below a fresh one', () => {
    const tired = stabilityScore({
      speedKmph: 44, harshBrakingEvents: 3, hoursOnDuty: 7.5, earRatio: 0.18,
    });
    const fresh = stabilityScore({
      speedKmph: 44, harshBrakingEvents: 0, hoursOnDuty: 2, earRatio: 0.30,
    });
    assert.ok(tired < fresh, `${tired} should be worse than ${fresh}`);
  });
});

describe('ETA model', () => {
  // The parameter is `stopOccupancyPct`. Naming it `occupancyPct` here would be
  // silently ignored and the dwell term would read zero — the exact way a
  // crowding factor can end up dead in production without anything failing.
  const base = { distanceKm: 6, signalCongestionScore: 0.5, stopOccupancyPct: 40, isoDayOfWeek: 3 };

  it('breaks down into terms that sum to the quoted minutes', () => {
    const { etaMins, breakdown } = estimateEta({ ...base, weather: 'clear' });
    const sum = breakdown.reduce((n, b) => n + b.mins, 0);
    // The panel renders the breakdown as an explanation of the headline number.
    // If they can disagree, the explanation is decoration.
    assert.ok(Math.abs(sum - etaMins) < 0.15, `terms sum to ${sum}, headline is ${etaMins}`);
    assert.equal(breakdown.length, 4);
  });

  it('makes rain cost more than clear, and only through the weather term', () => {
    const clear = estimateEta({ ...base, weather: 'clear' });
    const wet = estimateEta({ ...base, weather: 'heavy_rain' });
    assert.ok(wet.etaMins > clear.etaMins);

    const term = (r) => r.breakdown.find((b) => b.label === 'Weather').mins;
    assert.equal(term(clear), WEATHER_PENALTY.clear);
    assert.equal(term(wet), WEATHER_PENALTY.heavy_rain);

    // Every other term must be untouched — that invariant is what lets the UI
    // claim the weather selector isolates one factor.
    const others = (r) => r.breakdown.filter((b) => b.label !== 'Weather').map((b) => b.mins);
    assert.deepEqual(others(clear), others(wet));
  });

  it('costs a congested signal corridor more than a clear one', () => {
    const free = estimateEta({ ...base, signalCongestionScore: 0, weather: 'clear' });
    const jammed = estimateEta({ ...base, signalCongestionScore: 1, weather: 'clear' });
    assert.ok(jammed.etaMins > free.etaMins);
  });

  it('costs a crowded platform more, via boarding dwell', () => {
    const quiet = estimateEta({ ...base, stopOccupancyPct: 0, weather: 'clear' });
    const packed = estimateEta({ ...base, stopOccupancyPct: 100, weather: 'clear' });
    assert.ok(packed.etaMins > quiet.etaMins, `${packed.etaMins} should exceed ${quiet.etaMins}`);

    const dwell = (r) => r.breakdown.find((b) => b.label === 'Boarding dwell').mins;
    assert.equal(dwell(quiet), 0);
    assert.ok(dwell(packed) > 0);
  });

  it('reports a confidence percentage in range', () => {
    const { confidencePct } = estimateEta({ ...base, weather: 'rain' });
    assert.ok(confidencePct > 0 && confidencePct <= 100, `got ${confidencePct}`);
  });
});

describe('fares and carbon', () => {
  it('prices each mode from base plus distance', () => {
    assert.equal(legFare('walk', 2), 0);
    assert.equal(legFare('bus', 0), 8);
    assert.equal(legFare('metro', 1), 12.4);
    assert.throws(() => legFare('teleport', 1), /unknown mode/);
  });

  it('applies concessions from one table', () => {
    assert.equal(concessionFare(20, 'adult').payableFare, 20);
    assert.equal(concessionFare(20, 'student').payableFare, 10);
    assert.equal(concessionFare(20, 'child').payableFare, 7);
    assert.equal(concessionFare(20).passengerType, 'adult');
  });

  it('rejects an inherited property as a passenger type', () => {
    // `'toString' in FARE_MULTIPLIER` is true. Using `in` here would multiply the
    // fare by a function and issue a pass priced at NaN.
    assert.throws(() => concessionFare(20, 'toString'), /unknown passengerType/);
    assert.throws(() => concessionFare(20, 'constructor'), /unknown passengerType/);
    assert.ok(Object.hasOwn(FARE_MULTIPLIER, 'adult'));
  });

  it('measures carbon saved against a car for the same distance', () => {
    const legs = [
      { mode: 'walk', distanceKm: 0.35 },
      { mode: 'bus', distanceKm: 5 },
      { mode: 'metro', distanceKm: 8 },
    ];
    const c = carbonSaved(legs);
    assert.ok(c.gramsSaved > 0);
    assert.ok(c.gramsIfCar > c.gramsUsed);
    // kgSaved is rounded to 2dp, so it agrees with gramsSaved to within 5 g by
    // construction — asserting exact equality would be asserting away the rounding.
    assert.ok(Math.abs(c.kgSaved * 1000 - c.gramsSaved) <= 5,
      `${c.kgSaved} kg vs ${c.gramsSaved} g`);
  });

  it('never reports a negative saving', () => {
    // A pure-walk trip emits nothing, so the saving is the whole car figure; the
    // guard matters for any future mode dirtier than a car.
    assert.ok(carbonSaved([{ mode: 'walk', distanceKm: 1 }]).gramsSaved >= 0);
  });
});

describe('geography', () => {
  it('measures a known Mumbai pair to within a few hundred metres', () => {
    // Central Station (19.076, 72.8777) to Andheri Metro (19.1197, 72.8464):
    // roughly 5.8 km as the crow flies.
    const km = haversineKm(19.076, 72.8777, 19.1197, 72.8464);
    assert.ok(km > 5.3 && km < 6.3, `got ${km} km`);
  });

  it('returns zero for a point to itself', () => {
    assert.equal(haversineKm(19.076, 72.8777, 19.076, 72.8777), 0);
  });

  it('inflates straight-line distance into a road distance', () => {
    const straight = haversineKm(19.076, 72.8777, 19.1197, 72.8464);
    assert.ok(roadDistanceKm(19.076, 72.8777, 19.1197, 72.8464) > straight);
  });
});
