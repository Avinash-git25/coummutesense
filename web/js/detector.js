/**
 * CommuteIQ — crowd detection (PRD Feature 1).
 *
 * ── What is actually running here ───────────────────────────────────────────
 * YOLOv8 IS NOT RUNNING IN THIS PROTOTYPE. There is no neural network in this
 * file, no ONNX runtime, no downloaded weights. What follows is a classical
 * computer-vision pipeline — background subtraction, morphology, connected
 * components, shape filtering, centroid tracking — written out in full over raw
 * pixels. It is a real detector and it really counts people; it is simply not a
 * learned one, and the console must not be read as implying otherwise.
 *
 * That is a deliberate constraint, not a shortcut we are hiding. This project
 * ships with zero third-party dependencies, so an inference runtime is not
 * available to us; and a classical baseline is the honest thing to compare a
 * learned model against anyway. Because the footage in scene.js carries exact
 * ground truth, the accuracy figure the console reports is a measurement of this
 * pipeline, and swapping in YOLOv8 later would be measured the same way on the
 * same frames.
 *
 * ── The swap-in point ──────────────────────────────────────────────────────
 * `Detector` is the seam. Everything else in the system — the render loop, the
 * tracker, the crowd API, the accuracy panel — talks only to `detect(imageData)`
 * and the `{boxes, count, inferenceMs}` it returns. A future
 *
 *     export class YoloDetector extends Detector {
 *       async load(url) { ... }
 *       detect(imageData) { ...; return { boxes, count, inferenceMs }; }
 *     }
 *
 * replaces `BackgroundSubtractionDetector` at one construction site and no other
 * file changes. Keeping the contract synchronous and pixel-in/boxes-out is what
 * makes that true.
 *
 * ── Why it is pure computation ─────────────────────────────────────────────
 * Nothing here touches `document`, `window`, a canvas or a video element. The
 * input is any `{width, height, data: Uint8ClampedArray}` — which a browser
 * ImageData satisfies, and which a test can build by hand in eleven lines — so
 * the pipeline is unit-testable under Node with no DOM and no headless browser.
 */

/**
 * Detection interface. Subclass this to plug a different detector into
 * Feature 1; do not instantiate it directly.
 */
export class Detector {
  /**
   * @param {{width:number, height:number, data:Uint8ClampedArray}} _imageData RGBA frame
   * @returns {{boxes:Array<{x:number,y:number,w:number,h:number,area:number}>, count:number, inferenceMs:number}}
   */
  detect(_imageData) {
    throw new Error('Detector.detect must be implemented by a subclass');
  }

  /** Discard any per-stream state. Called when the footage restarts. */
  reset() {}

  /** Human-readable identity, shown in the console so the method is never in doubt. */
  get label() { return 'abstract detector'; }
}

// ── tuned defaults ──────────────────────────────────────────────────────────

/**
 * Absolute luminance difference above which a pixel is foreground.
 *
 * 25 levels on a 0-255 scale. Sensor noise and anti-aliased edges in the
 * synthetic footage sit well under that; every clothing colour in scene.js sits
 * at least 39 levels away from the platform grey. Lower it and speckle floods
 * the mask; raise it much and dark trousers against dark paving disappear.
 */
export const DEFAULT_THRESHOLD = 25;

/**
 * How fast an unoccupied pixel forgets. 0.02 per frame is a time constant of
 * about 50 frames, or 1.7s at 30fps — quick enough to follow a lighting drift,
 * slow enough that it does not chase a person who pauses.
 */
export const DEFAULT_LEARNING_RATE = 0.02;

/** Frames of clean background averaged before any detection is attempted. */
export const DEFAULT_WARMUP_FRAMES = 8;

/**
 * Plausible shape of an upright person, as bounding-box height / width.
 *
 * A standing adult silhouette lands near 2.2. The window is generous at both
 * ends to survive erosion trimming the legs off distant figures, but it closes
 * well before 0.9, which is what rejects the bus (height/width near 0.14) and
 * any horizontal lighting band.
 */
export const DEFAULT_MIN_ASPECT = 0.9;
export const DEFAULT_MAX_ASPECT = 7.0;

const now = () => performance.now();

/**
 * Background-subtraction crowd detector.
 *
 * The pipeline, in order, all of it implemented here rather than called out to:
 *
 *   1. per-pixel running-average background model over greyscale, seeded from
 *      the first `warmupFrames` frames;
 *   2. absolute difference against the model, thresholded to a binary mask;
 *   3. morphological opening (erode then dilate) to delete speckle, then closing
 *      (dilate then erode) to seal holes, both with a 3x3 square element;
 *   4. connected-component labelling by iterative flood fill with an explicit
 *      stack;
 *   5. rejection of components by area and by aspect ratio and fill;
 *   6. merging of overlapping survivors so one person split in two is counted
 *      once.
 */
export class BackgroundSubtractionDetector extends Detector {
  #w = 0;
  #h = 0;
  #frames = 0;

  /** @type {Float32Array|null} per-pixel background luminance */
  #bg = null;
  /** @type {Uint8Array|null} binary foreground mask, reused every frame */
  #mask = null;
  /** @type {Uint8Array|null} morphology scratch buffer */
  #scratch = null;
  /** @type {Int32Array|null} component labels */
  #labels = null;
  /** @type {Int32Array|null} flood-fill stack */
  #stack = null;

  #opts;

  /**
   * @param {object} [options]
   * @param {number} [options.threshold] luminance difference for foreground
   * @param {number} [options.learningRate] background adaptation rate, 0..1
   * @param {number} [options.foregroundLearningRate] much slower rate applied under the mask
   * @param {number} [options.warmupFrames] frames averaged before detecting
   * @param {number} [options.minArea] smallest component accepted, in pixels
   * @param {number} [options.maxAreaFrac] largest component accepted, as a fraction of the frame
   * @param {number} [options.minAspect] smallest box height/width accepted
   * @param {number} [options.maxAspect] largest box height/width accepted
   * @param {number} [options.minFill] smallest component area / box area accepted
   * @param {number} [options.mergeIou] intersection-over-union above which boxes merge
   * @param {number} [options.mergeContainment] intersection / smaller-box area above which boxes merge
   */
  constructor(options = {}) {
    super();
    const o = options ?? {};
    this.#opts = {
      threshold: num(o.threshold, DEFAULT_THRESHOLD, 1, 255),
      learningRate: num(o.learningRate, DEFAULT_LEARNING_RATE, 0, 1),
      // Not zero: a permanently stationary object would otherwise be reported
      // forever. A rate this small takes minutes to absorb one, which is longer
      // than any bus dwells but shorter than the demo.
      foregroundLearningRate: num(o.foregroundLearningRate, 0.0006, 0, 1),
      warmupFrames: Math.round(num(o.warmupFrames, DEFAULT_WARMUP_FRAMES, 1, 600)),
      minArea: num(o.minArea, 45, 1, 1e9),
      maxAreaFrac: num(o.maxAreaFrac, 0.08, 0.0001, 1),
      minAspect: num(o.minAspect, DEFAULT_MIN_ASPECT, 0.01, 100),
      maxAspect: num(o.maxAspect, DEFAULT_MAX_ASPECT, 0.02, 1000),
      minFill: num(o.minFill, 0.20, 0, 1),
      mergeIou: num(o.mergeIou, 0.45, 0, 1),
      mergeContainment: num(o.mergeContainment, 0.60, 0, 1),
    };
  }

  get label() { return 'classical: background subtraction + connected components'; }

  /** Current tuning, so the console can show what the numbers were produced with. */
  get options() { return { ...this.#opts }; }

  /** True once the background model has seen enough frames to be trusted. */
  get ready() { return this.#frames > this.#opts.warmupFrames; }

  /** Frames consumed since the last reset. */
  get frameCount() { return this.#frames; }

  /**
   * The cleaned binary mask from the most recent frame, one byte per pixel.
   * Exposed for the debug overlay: showing the mask is the only way a viewer can
   * see that this is pixel work and not a scripted number.
   * @returns {Uint8Array|null}
   */
  get mask() { return this.#mask; }
  get maskWidth() { return this.#w; }
  get maskHeight() { return this.#h; }

  reset() {
    this.#frames = 0;
    if (this.#bg) this.#bg.fill(0);
    if (this.#mask) this.#mask.fill(0);
    if (this.#labels) this.#labels.fill(0);
  }

  /**
   * Run the pipeline over one frame.
   * @param {{width:number, height:number, data:Uint8ClampedArray}} imageData
   * @returns {{boxes:Array<{x:number,y:number,w:number,h:number,area:number}>, count:number, inferenceMs:number, warmingUp:boolean, foregroundPx:number}}
   */
  detect(imageData) {
    const started = now();
    const { width, height, data } = validateFrame(imageData);
    this.#ensureBuffers(width, height);

    this.#frames += 1;
    const warming = this.#frames <= this.#opts.warmupFrames;

    const foregroundPx = warming ? this.#seedBackground(data) : this.#threshold(data);

    if (warming) {
      return {
        boxes: [], count: 0, inferenceMs: round2(now() - started),
        warmingUp: true, foregroundPx: 0,
      };
    }

    // Step 3. Opening first: removing speckle before closing stops isolated
    // noise pixels being dilated into blobs large enough to pass the area filter.
    this.#erode();
    this.#dilate();
    this.#dilate();
    this.#erode();

    const cleaned = this.#countMask();
    const components = this.#components();
    const kept = this.#filter(components);
    const boxes = mergeBoxes(kept, this.#opts.mergeIou, this.#opts.mergeContainment);

    // Step 1, second half. Adapt using the CLEANED mask, so noise pixels that
    // morphology already dismissed are learned as background rather than being
    // protected from adaptation by their own noise.
    this.#adapt(data);

    boxes.sort((a, b) => a.x - b.x || a.y - b.y);

    return {
      boxes,
      count: boxes.length,
      inferenceMs: round2(now() - started),
      warmingUp: false,
      foregroundPx: cleaned,
    };
  }

  // ── pipeline stages ───────────────────────────────────────────────────────

  #ensureBuffers(width, height) {
    if (this.#w === width && this.#h === height && this.#bg) return;
    this.#w = width;
    this.#h = height;
    const n = width * height;
    this.#bg = new Float32Array(n);
    this.#mask = new Uint8Array(n);
    this.#scratch = new Uint8Array(n);
    this.#labels = new Int32Array(n);
    // Marking pixels on push, not on pop, means each pixel enters the stack at
    // most once — so one slot per pixel is provably enough and the fill can
    // never overflow, however large the blob.
    this.#stack = new Int32Array(n);
    this.#frames = 0;
  }

  /**
   * Step 1. Cumulative mean of the warm-up frames. A plain mean rather than an
   * exponential one here, so every calibration frame carries equal weight and
   * the model does not lean towards whatever the last one happened to show.
   */
  #seedBackground(data) {
    const bg = this.#bg;
    const n = bg.length;
    const k = this.#frames;
    for (let i = 0, p = 0; i < n; i += 1, p += 4) {
      const g = luma(data[p], data[p + 1], data[p + 2]);
      bg[i] += (g - bg[i]) / k;
    }
    this.#mask.fill(0);
    return 0;
  }

  /** Step 2. |frame - background| > threshold. */
  #threshold(data) {
    const bg = this.#bg;
    const mask = this.#mask;
    const t = this.#opts.threshold;
    const n = mask.length;
    let fg = 0;
    for (let i = 0, p = 0; i < n; i += 1, p += 4) {
      const g = luma(data[p], data[p + 1], data[p + 2]);
      const d = g - bg[i];
      const on = (d < 0 ? -d : d) > t ? 1 : 0;
      mask[i] = on;
      fg += on;
    }
    return fg;
  }

  /**
   * Selective adaptation. Pixels the mask calls background follow the frame;
   * pixels under the mask barely move, so someone standing still for thirty
   * seconds is not quietly absorbed into the platform.
   */
  #adapt(data) {
    const bg = this.#bg;
    const mask = this.#mask;
    const { learningRate, foregroundLearningRate } = this.#opts;
    const n = bg.length;
    for (let i = 0, p = 0; i < n; i += 1, p += 4) {
      const g = luma(data[p], data[p + 1], data[p + 2]);
      const rate = mask[i] === 1 ? foregroundLearningRate : learningRate;
      bg[i] += rate * (g - bg[i]);
    }
  }

  /**
   * Step 3a. Erosion with a 3x3 square: a pixel survives only if all eight
   * neighbours are foreground. Outside the frame counts as background, so the
   * border erodes — the alternative, treating it as foreground, would weld blobs
   * to the frame edge.
   */
  #erode() {
    const src = this.#mask;
    const dst = this.#scratch;
    const w = this.#w;
    const h = this.#h;
    dst.fill(0);
    for (let y = 1; y < h - 1; y += 1) {
      const row = y * w;
      for (let x = 1; x < w - 1; x += 1) {
        const i = row + x;
        if (src[i] === 0) continue;
        if (
          src[i - 1] && src[i + 1] &&
          src[i - w] && src[i - w - 1] && src[i - w + 1] &&
          src[i + w] && src[i + w - 1] && src[i + w + 1]
        ) dst[i] = 1;
      }
    }
    this.#mask = dst;
    this.#scratch = src;
  }

  /** Step 3b. Dilation with the same 3x3 square: any foreground neighbour wins. */
  #dilate() {
    const src = this.#mask;
    const dst = this.#scratch;
    const w = this.#w;
    const h = this.#h;
    dst.fill(0);
    for (let y = 0; y < h; y += 1) {
      const row = y * w;
      for (let x = 0; x < w; x += 1) {
        const i = row + x;
        if (src[i] === 0) continue;
        const y0 = y > 0 ? -1 : 0;
        const y1 = y < h - 1 ? 1 : 0;
        const x0 = x > 0 ? -1 : 0;
        const x1 = x < w - 1 ? 1 : 0;
        for (let dy = y0; dy <= y1; dy += 1) {
          const r = i + dy * w;
          for (let dx = x0; dx <= x1; dx += 1) dst[r + dx] = 1;
        }
      }
    }
    this.#mask = dst;
    this.#scratch = src;
  }

  #countMask() {
    const mask = this.#mask;
    let n = 0;
    for (let i = 0; i < mask.length; i += 1) n += mask[i];
    return n;
  }

  /**
   * Step 4. Eight-connected components by flood fill over an explicit stack.
   *
   * Recursion is not an option: a full-frame blob is hundreds of thousands of
   * pixels deep and would exhaust the JS call stack long before it finished.
   * @returns {Array<{minX:number,minY:number,maxX:number,maxY:number,area:number}>}
   */
  #components() {
    const mask = this.#mask;
    const labels = this.#labels;
    const stack = this.#stack;
    const w = this.#w;
    const h = this.#h;
    const n = mask.length;
    labels.fill(0);

    const out = [];
    let label = 0;

    for (let seed = 0; seed < n; seed += 1) {
      if (mask[seed] === 0 || labels[seed] !== 0) continue;

      label += 1;
      let top = 0;
      stack[top++] = seed;
      labels[seed] = label;

      let area = 0;
      let minX = w; let maxX = -1; let minY = h; let maxY = -1;

      while (top > 0) {
        const i = stack[--top];
        const x = i % w;
        const y = (i - x) / w;

        area += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        const yLo = y > 0 ? y - 1 : 0;
        const yHi = y < h - 1 ? y + 1 : h - 1;
        const xLo = x > 0 ? x - 1 : 0;
        const xHi = x < w - 1 ? x + 1 : w - 1;

        for (let ny = yLo; ny <= yHi; ny += 1) {
          const row = ny * w;
          for (let nx = xLo; nx <= xHi; nx += 1) {
            const j = row + nx;
            if (mask[j] === 1 && labels[j] === 0) {
              labels[j] = label;
              stack[top++] = j;
            }
          }
        }
      }

      out.push({ minX, minY, maxX, maxY, area });
    }
    return out;
  }

  /**
   * Step 5. Keep only components shaped like a standing person.
   *
   * Three independent rejections: too small (speckle, a bag, a bird), too large
   * (a bus, a shadow sweeping the platform, a lighting change), or the wrong
   * shape. `minFill` catches the thin diagonal streaks that survive morphology
   * with a plausible bounding box but almost no pixels in it.
   */
  #filter(components) {
    const { minArea, maxAreaFrac, minAspect, maxAspect, minFill } = this.#opts;
    const maxArea = this.#w * this.#h * maxAreaFrac;
    const kept = [];

    for (const c of components) {
      if (c.area < minArea || c.area > maxArea) continue;
      const w = c.maxX - c.minX + 1;
      const h = c.maxY - c.minY + 1;
      if (w <= 0 || h <= 0) continue;
      const aspect = h / w;
      if (aspect < minAspect || aspect > maxAspect) continue;
      if (c.area / (w * h) < minFill) continue;
      kept.push({ x: c.minX, y: c.minY, w, h, area: c.area });
    }
    return kept;
  }
}

// ── box geometry ────────────────────────────────────────────────────────────

/**
 * Intersection over union of two boxes.
 * @param {{x:number,y:number,w:number,h:number}} a
 * @param {{x:number,y:number,w:number,h:number}} b
 * @returns {number} 0..1
 */
export function iou(a, b) {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

function intersectionArea(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

/**
 * Step 6. Fuse boxes that plainly describe the same person.
 *
 * Two tests, because splits come in two flavours. High IoU catches two
 * components that overlap heavily — a torso labelled twice through a thin gap.
 * High containment (intersection over the SMALLER box) catches the asymmetric
 * case, a small fragment sitting inside a large box, where IoU stays low because
 * the areas are so unequal and no threshold on it would ever fire.
 *
 * A head detached from its torso overlaps neither way; that split is prevented
 * upstream by the closing step and by the head/shoulder overlap in the rendered
 * figure, which is the right place to solve it. Merging by vertical proximity
 * instead would fuse two people standing one behind the other.
 *
 * Iterates to a fixed point so a chain of three fragments collapses to one box.
 *
 * @param {Array<{x:number,y:number,w:number,h:number,area:number}>} boxes
 * @param {number} [iouThreshold]
 * @param {number} [containmentThreshold]
 * @returns {Array<{x:number,y:number,w:number,h:number,area:number}>}
 */
export function mergeBoxes(boxes, iouThreshold = 0.45, containmentThreshold = 0.60) {
  let current = boxes.map((b) => ({ ...b }));
  let merged = true;

  while (merged && current.length > 1) {
    merged = false;
    const next = [];
    const used = new Array(current.length).fill(false);

    for (let i = 0; i < current.length; i += 1) {
      if (used[i]) continue;
      let box = current[i];
      used[i] = true;

      for (let j = i + 1; j < current.length; j += 1) {
        if (used[j]) continue;
        const other = current[j];
        const inter = intersectionArea(box, other);
        if (inter === 0) continue;
        const containment = inter / Math.min(box.w * box.h, other.w * other.h);
        if (iou(box, other) <= iouThreshold && containment <= containmentThreshold) continue;

        const x = Math.min(box.x, other.x);
        const y = Math.min(box.y, other.y);
        const w = Math.max(box.x + box.w, other.x + other.w) - x;
        const h = Math.max(box.y + box.h, other.y + other.h) - y;
        // Cap the area at the union box: double-counting the shared pixels would
        // let a merged box fail its own fill check downstream.
        box = { x, y, w, h, area: Math.min(box.area + other.area, w * h) };
        used[j] = true;
        merged = true;
      }
      next.push(box);
    }
    current = next;
  }
  return current;
}

// ── tracking ────────────────────────────────────────────────────────────────

/**
 * Nearest-centroid tracker.
 *
 * ── Why the count needs this ───────────────────────────────────────────────
 * Per-frame detection counts flicker. A pedestrian passing behind a shelter post
 * drops out for three frames; a distant figure hovers either side of the minimum
 * area and blinks. Reporting the raw per-frame count would make the crowd label
 * in Feature 1 twitch between MODERATE and HIGH several times a second, which
 * reads as a broken system even when every individual frame was scored well.
 *
 * So identity is carried across frames instead. Boxes are matched to existing
 * tracks by nearest centroid within `maxDistance`, greedily and closest pair
 * first. An unmatched track is kept alive for `maxMissing` frames before being
 * dropped, which bridges short occlusions; a new track must be seen `minHits`
 * times before it counts, which suppresses one-frame false positives. This is
 * the matching half of SORT without the Kalman filter, which would need motion
 * models the demo does not warrant.
 */
export class CentroidTracker {
  #tracks = [];
  #nextId = 1;
  #frame = 0;
  #opts;

  /**
   * @param {object} [options]
   * @param {number} [options.maxDistance] furthest a centroid may move between frames, in pixels
   * @param {number} [options.maxMissing] frames a track survives unmatched
   * @param {number} [options.minHits] frames a track must be seen before it is counted
   */
  constructor(options = {}) {
    const o = options ?? {};
    this.#opts = {
      maxDistance: num(o.maxDistance, 48, 1, 1e6),
      maxMissing: Math.round(num(o.maxMissing, 8, 0, 1000)),
      minHits: Math.round(num(o.minHits, 2, 1, 1000)),
    };
  }

  /** Live tracks that have been seen often enough to be believed. */
  get count() {
    return this.#tracks.reduce((n, t) => n + (t.hits >= this.#opts.minHits ? 1 : 0), 0);
  }

  /** Every live track, confirmed or provisional. */
  get trackCount() { return this.#tracks.length; }

  /** Highest id issued so far — a rough footfall total for the session. */
  get idsIssued() { return this.#nextId - 1; }

  reset() {
    this.#tracks = [];
    this.#nextId = 1;
    this.#frame = 0;
  }

  /**
   * Associate this frame's boxes with existing tracks.
   * @param {Array<{x:number,y:number,w:number,h:number,area?:number}>} boxes
   * @returns {Array<{id:number,x:number,y:number,w:number,h:number,cx:number,cy:number,hits:number,missing:number,confirmed:boolean}>}
   */
  update(boxes) {
    this.#frame += 1;
    const list = Array.isArray(boxes) ? boxes : [];
    const dets = list.map((b) => ({
      x: b.x, y: b.y, w: b.w, h: b.h,
      cx: b.x + b.w / 2,
      cy: b.y + b.h / 2,
    }));

    // All candidate pairs, closest first. Greedy assignment over a sorted pair
    // list is O(n*m log nm) and, at the dozen-or-so objects in this scene,
    // indistinguishable from the optimal Hungarian assignment.
    const pairs = [];
    for (let ti = 0; ti < this.#tracks.length; ti += 1) {
      const t = this.#tracks[ti];
      for (let di = 0; di < dets.length; di += 1) {
        const d = dets[di];
        const dist = Math.hypot(t.cx - d.cx, t.cy - d.cy);
        if (dist <= this.#opts.maxDistance) pairs.push({ ti, di, dist });
      }
    }
    pairs.sort((a, b) => a.dist - b.dist);

    const takenTrack = new Set();
    const takenDet = new Set();
    for (const p of pairs) {
      if (takenTrack.has(p.ti) || takenDet.has(p.di)) continue;
      takenTrack.add(p.ti);
      takenDet.add(p.di);

      const t = this.#tracks[p.ti];
      const d = dets[p.di];
      t.x = d.x; t.y = d.y; t.w = d.w; t.h = d.h;
      t.cx = d.cx; t.cy = d.cy;
      t.hits += 1;
      t.missing = 0;
      t.lastSeenFrame = this.#frame;
    }

    for (let di = 0; di < dets.length; di += 1) {
      if (takenDet.has(di)) continue;
      const d = dets[di];
      this.#tracks.push({
        id: this.#nextId++,
        x: d.x, y: d.y, w: d.w, h: d.h,
        cx: d.cx, cy: d.cy,
        hits: 1,
        missing: 0,
        lastSeenFrame: this.#frame,
      });
    }

    const survivors = [];
    for (let ti = 0; ti < this.#tracks.length; ti += 1) {
      const t = this.#tracks[ti];
      if (!takenTrack.has(ti) && t.lastSeenFrame !== this.#frame) {
        t.missing += 1;
        if (t.missing > this.#opts.maxMissing) continue;
      }
      survivors.push(t);
    }
    this.#tracks = survivors;

    return this.#tracks.map((t) => ({
      id: t.id,
      x: t.x, y: t.y, w: t.w, h: t.h,
      cx: t.cx, cy: t.cy,
      hits: t.hits,
      missing: t.missing,
      confirmed: t.hits >= this.#opts.minHits,
    }));
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** ITU-R BT.601 luma. The weights matter: a flat RGB mean makes yellow and blue
 * of equal brightness, and a high-visibility jacket would then vanish against a
 * blue-grey platform. */
function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Guard the one thing every stage assumes: that `data` really is 4 bytes per
 * pixel for the stated dimensions. A mismatch would otherwise read past the end
 * of the buffer and silently produce a mask of zeroes.
 */
function validateFrame(imageData) {
  if (!imageData || typeof imageData !== 'object') {
    throw new TypeError('detect requires an ImageData-like {width, height, data}');
  }
  const width = Number(imageData.width);
  const height = Number(imageData.height);
  const { data } = imageData;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError(`invalid frame dimensions: ${imageData.width}x${imageData.height}`);
  }
  if (!data || typeof data.length !== 'number') {
    throw new TypeError('frame.data must be a Uint8ClampedArray-like buffer');
  }
  if (data.length < width * height * 4) {
    throw new TypeError(`frame.data too short: ${data.length} bytes for ${width}x${height} RGBA`);
  }
  return { width, height, data };
}

function num(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, lo), hi);
}

const round2 = (n) => Math.round(n * 100) / 100;
