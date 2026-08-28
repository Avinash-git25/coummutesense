/**
 * The computer-vision pipeline (PRD Feature 1).
 *
 * Feature 1 is the claim the whole prototype is judged on, and it is the one
 * place where a number on screen could most easily be theatre. So these tests
 * run the real pipeline over frames built pixel by pixel here, where the number
 * of people is known by construction, and check that the detector recovers it.
 * That is the same shape of measurement the console reports on screen against
 * `scene.js`'s ground truth — this file just does it somewhere a CI run can see.
 *
 * `detector.js` touches no DOM, which is what makes this possible: a frame is
 * `{width, height, data}` and nothing more, so a test can author one directly
 * instead of standing up a headless browser to paint it.
 *
 * Several of the assertions below exist to pin claims the source states in prose,
 * because a comment that says "someone standing still is not absorbed into the
 * platform" is a promise, and an unverified promise about a tuning constant is
 * the kind that quietly stops being true.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  BackgroundSubtractionDetector,
  CentroidTracker,
  Detector,
  iou,
  mergeBoxes,
} from '../web/js/detector.js';

// ── frame construction ──────────────────────────────────────────────────────

const W = 160;
const H = 120;

/** Platform grey, luma 128. */
const BG = 128;

/**
 * Dark clothing, luma 40 — 88 levels from the background, comfortably past the
 * detector's threshold of 25. Using a near-threshold colour here would make the
 * suite a test of the constant rather than of the pipeline.
 */
const FG = 40;

/** A uniform grey frame. */
function blankFrame() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    data[i * 4] = BG;
    data[i * 4 + 1] = BG;
    data[i * 4 + 2] = BG;
    data[i * 4 + 3] = 255;
  }
  return { width: W, height: H, data };
}

/** Paint a filled rectangle of luma `v`. */
function rect(frame, x, y, w, h, v = FG) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const p = (yy * W + xx) * 4;
      frame.data[p] = v;
      frame.data[p + 1] = v;
      frame.data[p + 2] = v;
    }
  }
  return frame;
}

/**
 * A person: 12x30, aspect 2.5, which sits mid-window for the 0.9-7.0 filter.
 * Kept clear of the frame border because erosion treats outside-the-frame as
 * background, so a figure touching the edge would be trimmed.
 */
function person(frame, x, y = 40) {
  return rect(frame, x, y, 12, 30);
}

/** Feed enough blank frames that the background model is trusted. */
function warmUp(det) {
  for (let i = 0; i < 12; i += 1) det.detect(blankFrame());
  assert.equal(det.ready, true, 'detector should be past warm-up');
}

/** A frame holding `xs.length` people at the given x positions. */
function crowdFrame(xs) {
  const f = blankFrame();
  for (const x of xs) person(f, x);
  return f;
}

/** Well-separated positions: 18 px of clear space between 12 px figures. */
const FIVE = [10, 40, 70, 100, 130];

// ── the interface ───────────────────────────────────────────────────────────

describe('detector interface', () => {
  it('refuses to be used directly', () => {
    // The seam only holds if the base class cannot be mistaken for an
    // implementation — a silently-returning stub would count zero people and
    // look like an empty platform.
    assert.throws(() => new Detector().detect(blankFrame()), /must be implemented/);
  });

  it('names the method it used, so the console never implies a model', () => {
    const label = new BackgroundSubtractionDetector().label;
    assert.match(label, /classical/);
    assert.doesNotMatch(label, /yolo|neural|deep/i);
  });
});

// ── counting ────────────────────────────────────────────────────────────────

describe('crowd counting', () => {
  it('reports nothing while the background model is still calibrating', () => {
    const det = new BackgroundSubtractionDetector();
    const first = det.detect(crowdFrame(FIVE));
    // A count emitted during warm-up would be measured against a background of
    // zeroes, so the entire frame reads as foreground. Better to say "not yet".
    assert.equal(first.warmingUp, true);
    assert.equal(first.count, 0);
    assert.deepEqual(first.boxes, []);
  });

  it('finds an empty platform empty', () => {
    const det = new BackgroundSubtractionDetector();
    warmUp(det);
    const res = det.detect(blankFrame());
    assert.equal(res.count, 0);
    assert.equal(res.foregroundPx, 0);
  });

  it('counts five separated figures as five', () => {
    const det = new BackgroundSubtractionDetector();
    warmUp(det);
    const res = det.detect(crowdFrame(FIVE));
    assert.equal(res.count, 5, `boxes: ${JSON.stringify(res.boxes)}`);
    assert.equal(res.warmingUp, false);
  });

  it('recovers the count across a range of densities', () => {
    // The bands in Feature 1 are LOW/MODERATE/HIGH, so the pipeline has to be
    // right across the whole range and not just at one convenient occupancy.
    for (const n of [1, 2, 3, 5]) {
      const det = new BackgroundSubtractionDetector();
      warmUp(det);
      const xs = FIVE.slice(0, n);
      const res = det.detect(crowdFrame(xs));
      assert.equal(res.count, n, `expected ${n}, got ${res.count} at x=${xs}`);
    }
  });

  it('puts each box on the figure that produced it', () => {
    const det = new BackgroundSubtractionDetector();
    warmUp(det);
    const { boxes } = det.detect(crowdFrame(FIVE));
    assert.equal(boxes.length, 5);
    // Boxes come back sorted by x, so they pair up with the input positions.
    boxes.forEach((b, i) => {
      assert.ok(Math.abs(b.x - FIVE[i]) <= 2, `box ${i} at x=${b.x}, figure at ${FIVE[i]}`);
      assert.ok(Math.abs(b.y - 40) <= 2, `box ${i} at y=${b.y}, figure at 40`);
      assert.ok(b.h > b.w, 'a standing figure should be taller than it is wide');
    });
  });

  it('reports how long inference took, because the panel shows it', () => {
    const det = new BackgroundSubtractionDetector();
    warmUp(det);
    const { inferenceMs } = det.detect(crowdFrame(FIVE));
    assert.ok(Number.isFinite(inferenceMs) && inferenceMs >= 0, `got ${inferenceMs}`);
  });
});

// ── rejections ──────────────────────────────────────────────────────────────

describe('what the pipeline refuses to call a person', () => {
  it('rejects a bus on its shape', () => {
    const det = new BackgroundSubtractionDetector();
    warmUp(det);
    const f = blankFrame();
    rect(f, 30, 60, 80, 11); // aspect 0.14 — far below the 0.9 floor
    assert.equal(det.detect(f).count, 0);
  });

  it('rejects sensor speckle', () => {
    const det = new BackgroundSubtractionDetector();
    warmUp(det);
    const f = blankFrame();
    // Isolated pixels scattered across the frame. Erosion requires all eight
    // neighbours to be foreground, so these vanish in the opening step — which
    // is the reason opening runs before closing rather than after.
    for (let i = 0; i < 40; i += 1) rect(f, (i * 7) % 150 + 3, (i * 11) % 110 + 3, 1, 1);
    assert.equal(det.detect(f).count, 0);
  });

  it('rejects a lighting change that floods the frame', () => {
    const det = new BackgroundSubtractionDetector();
    warmUp(det);
    const f = blankFrame();
    rect(f, 0, 0, W, H, 200); // whole frame brightens
    // One component covering everything is past maxAreaFrac. Counting it would
    // report a single "person" the size of the platform every time a cloud moved.
    assert.equal(det.detect(f).count, 0);
  });

  it('rejects a figure too small to be a person at this range', () => {
    const det = new BackgroundSubtractionDetector();
    warmUp(det);
    const f = blankFrame();
    rect(f, 40, 40, 3, 6); // 18 px, under the 45 px floor even before erosion
    assert.equal(det.detect(f).count, 0);
  });
});

// ── the stationary-passenger claim ──────────────────────────────────────────

describe('a passenger who stops moving', () => {
  it('is still counted after ten seconds of standing still', () => {
    // This is the classic background-subtraction failure: adapt at a single rate
    // and anyone who stands still dissolves into the model, so a full platform
    // of waiting passengers reads as empty. That is the exact scenario Feature 1
    // exists to measure, so the source applies a much slower rate under the
    // mask, and this test is what holds that constant in place.
    const det = new BackgroundSubtractionDetector();
    warmUp(det);

    let res;
    for (let i = 0; i < 300; i += 1) res = det.detect(crowdFrame(FIVE)); // ~10 s at 30 fps
    assert.equal(res.count, 5, `after 300 stationary frames the count was ${res.count}`);
  });

  it('forgets a figure that leaves, on the next frame', () => {
    const det = new BackgroundSubtractionDetector();
    warmUp(det);
    for (let i = 0; i < 20; i += 1) det.detect(crowdFrame(FIVE));
    assert.equal(det.detect(blankFrame()).count, 0);
  });
});

// ── lifecycle ───────────────────────────────────────────────────────────────

describe('detector lifecycle', () => {
  it('re-calibrates after a reset, rather than trusting a stale model', () => {
    const det = new BackgroundSubtractionDetector();
    warmUp(det);
    assert.equal(det.detect(crowdFrame(FIVE)).count, 5);

    det.reset();
    assert.equal(det.ready, false);
    assert.equal(det.frameCount, 0);
    assert.equal(det.detect(crowdFrame(FIVE)).warmingUp, true);
  });

  it('exposes the cleaned mask, so the overlay can prove this is pixel work', () => {
    const det = new BackgroundSubtractionDetector();
    warmUp(det);
    det.detect(crowdFrame(FIVE));
    assert.equal(det.maskWidth, W);
    assert.equal(det.maskHeight, H);
    assert.equal(det.mask.length, W * H);
    assert.ok(det.mask.some((v) => v === 1), 'the mask should mark the figures');
  });

  it('rejects a frame whose buffer does not match its dimensions', () => {
    // Without this guard the pipeline reads past the end of the buffer and
    // returns a mask of zeroes — an empty platform, reported confidently.
    const det = new BackgroundSubtractionDetector();
    assert.throws(() => det.detect({ width: 100, height: 100, data: new Uint8ClampedArray(16) }), /too short/);
    assert.throws(() => det.detect({ width: 0, height: 5, data: new Uint8ClampedArray(4) }), /dimensions/);
    assert.throws(() => det.detect(null), /ImageData-like/);
  });
});

// ── box geometry ────────────────────────────────────────────────────────────

describe('box geometry', () => {
  it('measures intersection over union', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    assert.equal(iou(a, a), 1);
    assert.equal(iou(a, { x: 100, y: 100, w: 10, h: 10 }), 0);
    // Half-overlap: intersection 50, union 150.
    assert.ok(Math.abs(iou(a, { x: 5, y: 0, w: 10, h: 10 }) - 1 / 3) < 1e-9);
  });

  it('fuses a torso labelled twice', () => {
    const merged = mergeBoxes([
      { x: 10, y: 10, w: 12, h: 30, area: 360 },
      { x: 11, y: 11, w: 12, h: 30, area: 360 },
    ]);
    assert.equal(merged.length, 1);
  });

  it('fuses a fragment sitting inside a larger box, where IoU stays low', () => {
    // The asymmetric split: a 4x6 shard inside a 12x30 torso has an IoU of about
    // 0.067, so no IoU threshold would ever merge it. Containment catches it.
    const big = { x: 10, y: 10, w: 12, h: 30, area: 360 };
    const shard = { x: 12, y: 14, w: 4, h: 6, area: 24 };
    assert.ok(iou(big, shard) < 0.1, 'the premise is that IoU is low here');
    assert.equal(mergeBoxes([big, shard]).length, 1);
  });

  it('leaves two people standing side by side as two people', () => {
    const merged = mergeBoxes([
      { x: 10, y: 40, w: 12, h: 30, area: 360 },
      { x: 40, y: 40, w: 12, h: 30, area: 360 },
    ]);
    assert.equal(merged.length, 2);
  });

  it('collapses a chain of three fragments in one call', () => {
    // Iterating to a fixed point is the difference between one box and two: a
    // single pass would merge A into B and leave C behind.
    const merged = mergeBoxes([
      { x: 10, y: 10, w: 12, h: 30, area: 360 },
      { x: 11, y: 11, w: 12, h: 30, area: 360 },
      { x: 12, y: 12, w: 12, h: 30, area: 360 },
    ]);
    assert.equal(merged.length, 1);
  });

  it('never claims more area than the box it produced', () => {
    // A merged box that summed its parts' areas could exceed its own footprint
    // and then fail the fill filter that it had already passed.
    const [box] = mergeBoxes([
      { x: 0, y: 0, w: 10, h: 10, area: 100 },
      { x: 1, y: 1, w: 10, h: 10, area: 100 },
    ]);
    assert.ok(box.area <= box.w * box.h, `${box.area} px in a ${box.w}x${box.h} box`);
  });
});

// ── tracking ────────────────────────────────────────────────────────────────

describe('centroid tracking', () => {
  const at = (x, y = 40) => ({ x, y, w: 12, h: 30 });

  it('does not count a one-frame false positive', () => {
    // minHits is why the crowd label does not flicker. A blob that appears for a
    // single frame moves the band from MODERATE to HIGH and back, which reads as
    // a broken system even when every frame was scored correctly.
    const t = new CentroidTracker();
    t.update([at(10)]);
    assert.equal(t.count, 0, 'a first sighting is provisional');
    t.update([at(11)]);
    assert.equal(t.count, 1, 'a second sighting confirms it');
  });

  it('keeps one identity as a person walks', () => {
    const t = new CentroidTracker();
    for (let x = 10; x < 90; x += 6) t.update([at(x)]);
    assert.equal(t.count, 1);
    assert.equal(t.idsIssued, 1, 'a walking figure must not be issued a new id each frame');
  });

  it('bridges a short occlusion behind a shelter post', () => {
    const t = new CentroidTracker();
    t.update([at(10)]);
    t.update([at(14)]);
    assert.equal(t.count, 1);

    // Gone for four frames — fewer than maxMissing, so the track survives and
    // the platform count holds steady instead of dropping and recovering.
    for (let i = 0; i < 4; i += 1) t.update([]);
    assert.equal(t.count, 1, 'the count should not dip during a brief occlusion');

    t.update([at(30)]);
    assert.equal(t.idsIssued, 1, 're-appearing must not mint a second identity');
  });

  it('drops a track that leaves for good', () => {
    const t = new CentroidTracker({ maxMissing: 3 });
    t.update([at(10)]);
    t.update([at(12)]);
    for (let i = 0; i < 6; i += 1) t.update([]);
    assert.equal(t.count, 0);
    assert.equal(t.trackCount, 0);
  });

  it('treats a figure that jumps across the frame as a new person', () => {
    // Beyond maxDistance the nearest-centroid assumption breaks down, and
    // matching anyway would let one id teleport between two different people.
    const t = new CentroidTracker({ maxDistance: 20 });
    t.update([at(10)]);
    t.update([at(120)]);
    assert.equal(t.idsIssued, 2);
  });

  it('holds a steady count for a steady crowd', () => {
    // The property Feature 1's band label actually depends on: five people
    // milling about must read as five, every frame, not four-to-six.
    const t = new CentroidTracker();
    const jitter = [0, 1, -1, 2, -2, 1, 0, -1];
    for (let f = 0; f < 8; f += 1) {
      t.update(FIVE.map((x) => at(x + jitter[f])));
      if (f >= 1) assert.equal(t.count, 5, `frame ${f} counted ${t.count}`);
    }
  });

  it('starts clean after a reset', () => {
    const t = new CentroidTracker();
    t.update([at(10)]);
    t.update([at(11)]);
    t.reset();
    assert.equal(t.count, 0);
    assert.equal(t.trackCount, 0);
    assert.equal(t.idsIssued, 0);
  });

  it('survives a frame with no detections at all', () => {
    const t = new CentroidTracker();
    assert.doesNotThrow(() => t.update([]));
    assert.doesNotThrow(() => t.update(null));
    assert.equal(t.count, 0);
  });
});
