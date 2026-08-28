/**
 * CommuteIQ — synthetic transit-node footage (PRD Feature 1 input).
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * PRD Feature 1 says the crowd tracker runs on "pre-stored sample CCTV feeds".
 * No footage ships with this project, and none can: video files are large, the
 * licensing of real platform CCTV is not ours to assume, and a recorded clip has
 * no ground truth attached, so there would be nothing to measure accuracy
 * against. That leaves Feature 1 with no defined input at all.
 *
 * So we generate the footage instead. This module renders a bus-stop platform to
 * a plain Canvas 2D context, frame by frame, and — crucially — knows exactly how
 * many pedestrians it drew. `groundTruthCount()` is that number, not an
 * estimate, which is what makes the detector's accuracy figure in the console a
 * real measurement rather than a claim.
 *
 * Two properties matter more than looking pretty:
 *
 *   1. DETERMINISM. Everything random comes from a seeded PRNG and time is
 *      consumed in fixed 1/30s substeps, so the same seed produces the same
 *      footage on every run and the accuracy benchmark is reproducible. Nothing
 *      here calls Math.random.
 *
 *   2. A GENUINELY STATIC BACKGROUND. The detector in detector.js models the
 *      background per pixel, so the platform, markings and shelter are redrawn
 *      at identical coordinates every frame. Even the grime speckles are drawn
 *      from a list computed once, rather than re-rolled per frame, because
 *      per-frame noise in the background is exactly what breaks background
 *      subtraction.
 *
 * The module never touches `document` or `window`: `draw(ctx)` is handed a
 * context by the caller, so the scene can be rendered to an OffscreenCanvas, or
 * driven headless in a test, without a DOM.
 */

// ── timing ──────────────────────────────────────────────────────────────────

/**
 * Simulation substep. `step()` accumulates real elapsed time and consumes it in
 * fixed slices, so a dropped display frame changes when things happen but never
 * how they happen — a variable dt would make the PRNG draw sequence depend on
 * the host's frame rate and the footage would differ between machines.
 */
export const FIXED_STEP_MS = 1000 / 30;

/** Ceiling on catch-up work, so returning to a backgrounded tab cannot stall it. */
const MAX_SUBSTEPS = 6;

/**
 * Nothing spawns for this long after a reset. The detector needs a handful of
 * people-free frames to seed its background model; anyone standing on the
 * platform during that window would be absorbed INTO the background and then be
 * permanently invisible. Holding the platform empty briefly is the scene's half
 * of that bargain (the other half is `drawBackground`, for callers that want to
 * calibrate properly).
 */
const CALIBRATION_HOLD_MS = 600;

// ── bus timetable ───────────────────────────────────────────────────────────

const BUS_PERIOD_MS = 22_000;
const BUS_APPROACH_MS = 2600;
const BUS_DWELL_MS = 5200;
const BUS_DEPART_MS = 2600;

// ── layout, as fractions of the frame ───────────────────────────────────────

/**
 * Vertical bands of the shot, top to bottom. Exported because the console's
 * debug overlay draws the walking band to explain where detections are expected.
 *
 * The kerb sits high in the frame and the bus stops on it, so the bus is BEHIND
 * every pedestrian and occludes none of them. That is a deliberate framing
 * choice: pedestrian occlusion by a 12-metre vehicle would dominate the accuracy
 * number and tell us nothing about the detector.
 */
export const LAYOUT = {
  wallBottom: 0.20,
  roadBottom: 0.30,
  busBodyTop: 0.075,
  busBodyBottom: 0.255,
  bandTop: 0.44,      // feet of the most distant pedestrian
  bandBottom: 0.94,   // feet of the nearest pedestrian
  boardingY: 0.415,   // feet of someone stepping through the bus door
};

/**
 * Figure height as a fraction of frame height, far (0) to near (1).
 *
 * These are deliberately modest against a walking band half the frame deep. The
 * ratio of figure height to band depth is what decides how often two people in
 * different lanes overlap vertically, and every overlap welds two silhouettes
 * into one blob that a connected-component counter can only report as one
 * person. A steeper camera — which is what a real platform CCTV mount gives you
 * — separates the lanes, and this geometry approximates that.
 */
const FIGURE_H_FAR = 0.075;
const FIGURE_H_NEAR = 0.185;

/** Silhouette width as a fraction of its own height, arms included. */
const FIGURE_W_RATIO = 0.40;

/** Hard ceiling on population, so a runaway target cannot melt the frame rate. */
export const MAX_FIGURES = 40;

/**
 * Clothing colours. Every one of these is far from the platform grey in
 * luminance — at least 39 levels on a 0-255 scale, against the detector's
 * default threshold of 25. Mid-greys are absent on purpose: a pedestrian the
 * same brightness as the platform is invisible to background subtraction, which
 * would be a property of the footage masquerading as a property of the detector.
 */
const COAT_COLOURS = [
  '#2d3a4f', '#7d2f3a', '#1f5f4b', '#4a3b8c', '#b8452a',
  '#eae0c8', '#f4f4f6', '#f0c02a', '#23282e', '#a8306b',
];
const TROUSER_COLOURS = ['#2b2f38', '#3a3226', '#1e2a3a', '#4a4f57'];
const HAIR_COLOURS = ['#2b1f18', '#5c4030', '#141210', '#6b5a3a'];

/**
 * Deterministic PRNG (mulberry32).
 *
 * Duplicated from server/sim.js rather than shared: that module is server-side
 * and imports the event bus, so pulling it into the browser bundle would drag
 * node:events along with it.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeIn = (t) => t ** 3;

/**
 * A procedurally rendered, deterministic bus-stop scene with known ground truth.
 *
 * Usage per animation frame: `step(dtMs)` then `draw(ctx)`, then read the pixels
 * back and hand them to a Detector. `groundTruthCount()` is valid immediately
 * after `step()`.
 */
export class Scene {
  #width;
  #height;
  #seed;
  #rand;

  /** @type {Array<object>} live pedestrian figures */
  #figures = [];
  #nextFigureId = 1;
  #target = 12;

  #accMs = 0;
  #elapsedMs = 0;
  #frameIndex = 0;
  #spawnTimerMs = 0;

  #busClockMs = 0;
  #busPhase = 'absent';
  #busX = 0;
  #busBoardingArmed = false;

  #boardedTotal = 0;
  #departedTotal = 0;

  /** Static background blemishes, rolled once so the background never flickers. */
  #grime = [];

  /**
   * @param {number} width  frame width in pixels
   * @param {number} height frame height in pixels
   * @param {number} [seed] PRNG seed; the same seed replays the same footage
   */
  constructor(width, height, seed = 1234) {
    this.#width = Math.max(64, Math.round(Number(width) || 640));
    this.#height = Math.max(64, Math.round(Number(height) || 360));
    this.#seed = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : 1234;
    this.reset();
  }

  get width() { return this.#width; }
  get height() { return this.#height; }
  get frameIndex() { return this.#frameIndex; }
  get elapsedMs() { return this.#elapsedMs; }

  /** Return the scene to frame zero. Same seed, so the same footage follows. */
  reset() {
    this.#rand = mulberry32(this.#seed);
    this.#figures = [];
    this.#nextFigureId = 1;
    this.#accMs = 0;
    this.#elapsedMs = 0;
    this.#frameIndex = 0;
    this.#spawnTimerMs = 0;
    this.#busClockMs = 0;
    this.#busPhase = 'absent';
    this.#busX = this.#width;
    this.#busBoardingArmed = false;
    this.#boardedTotal = 0;
    this.#departedTotal = 0;
    this.#rollGrime();
  }

  /**
   * How many people the platform should hold. The scenario driver moves this up
   * and down to stage the crowd build; figures walk in and out to follow it
   * rather than appearing and vanishing, since a figure that pops out of
   * existence leaves a hole no background model can explain.
   *
   * @param {number} n desired population, clamped to 0..MAX_FIGURES
   */
  setCrowdTarget(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return;
    this.#target = clamp(Math.round(v), 0, MAX_FIGURES);
  }

  /** @returns {number} the current crowd target. */
  crowdTarget() { return this.#target; }

  /**
   * THE GROUND TRUTH. The number of pedestrian figures the renderer actually
   * drew inside the frame this instant — counted, never inferred, and never
   * derived from anything the detector produced.
   *
   * "Inside the frame" means the figure's centre is within the canvas, the usual
   * multi-object-tracking convention. A half-entered figure is drawn as a
   * partial silhouette that the detector may well pick up, so counting by centre
   * keeps ground truth and detector aligned at the frame edge instead of
   * manufacturing an error there.
   *
   * @returns {number}
   */
  groundTruthCount() {
    let n = 0;
    for (const p of this.#figures) {
      if (p.x >= 0 && p.x <= this.#width) n += 1;
    }
    return n;
  }

  /**
   * Boxes the renderer knows it drew, for diagnostics and for scoring detection
   * quality beyond a bare count. Same convention as `groundTruthCount`.
   * @returns {Array<{id:number, x:number, y:number, w:number, h:number}>}
   */
  groundTruthBoxes() {
    const out = [];
    for (const p of this.#figures) {
      if (p.x < 0 || p.x > this.#width) continue;
      const w = p.h * FIGURE_W_RATIO;
      out.push({
        id: p.id,
        x: Math.round(p.x - w * 0.49),
        y: Math.round(p.feetY - p.h * 0.89),
        w: Math.round(w * 0.98),
        h: Math.round(p.h * 0.89),
      });
    }
    return out;
  }

  /** Compact state for the console HUD. */
  snapshot() {
    return {
      frameIndex: this.#frameIndex,
      elapsedMs: Math.round(this.#elapsedMs),
      groundTruth: this.groundTruthCount(),
      target: this.#target,
      busPhase: this.#busPhase,
      boardedTotal: this.#boardedTotal,
      departedTotal: this.#departedTotal,
    };
  }

  /**
   * Advance the scene by real elapsed time.
   * @param {number} dtMs milliseconds since the previous call
   */
  step(dtMs) {
    const dt = Number.isFinite(Number(dtMs)) ? Number(dtMs) : 0;
    this.#accMs += clamp(dt, 0, FIXED_STEP_MS * MAX_SUBSTEPS);
    let guard = MAX_SUBSTEPS;
    while (this.#accMs >= FIXED_STEP_MS && guard > 0) {
      this.#accMs -= FIXED_STEP_MS;
      guard -= 1;
      this.#substep(FIXED_STEP_MS);
    }
  }

  // ── simulation ────────────────────────────────────────────────────────────

  #substep(dt) {
    this.#elapsedMs += dt;
    this.#frameIndex += 1;
    this.#advanceBus(dt);
    this.#advanceFigures(dt);
    this.#managePopulation(dt);
  }

  #advanceBus(dt) {
    this.#busClockMs += dt;
    const t = this.#busClockMs % BUS_PERIOD_MS;
    const busW = this.#width * 0.62;
    const stopX = this.#width * 0.18;

    if (t < BUS_APPROACH_MS) {
      this.#busPhase = 'approach';
      this.#busX = lerp(this.#width * 1.02, stopX, easeOut(t / BUS_APPROACH_MS));
      this.#busBoardingArmed = true;
    } else if (t < BUS_APPROACH_MS + BUS_DWELL_MS) {
      this.#busPhase = 'dwell';
      this.#busX = stopX;
      // Edge-triggered: choose the boarding party once per stop, not per frame.
      if (this.#busBoardingArmed) {
        this.#busBoardingArmed = false;
        this.#chooseBoarders();
      }
    } else if (t < BUS_APPROACH_MS + BUS_DWELL_MS + BUS_DEPART_MS) {
      if (this.#busPhase !== 'depart') this.#releaseBoarders();
      this.#busPhase = 'depart';
      const f = (t - BUS_APPROACH_MS - BUS_DWELL_MS) / BUS_DEPART_MS;
      this.#busX = lerp(stopX, -busW * 1.05, easeIn(f));
    } else {
      if (this.#busPhase !== 'absent') this.#releaseBoarders();
      this.#busPhase = 'absent';
      this.#busX = this.#width * 1.2;
    }
  }

  /** Door position of the stopped bus, in frame coordinates. */
  #doorX() {
    return this.#busX + this.#width * 0.62 * 0.70;
  }

  /**
   * Send the few people standing nearest the door onto the bus. This is what
   * makes the count drop visibly mid-demo, and it is the one place figures leave
   * without walking off the edge — legitimately, because they are stepping into
   * a vehicle that is drawn over the spot they vacate.
   */
  #chooseBoarders() {
    const wanted = Math.min(3 + Math.floor(this.#rand() * 4), this.#figures.length);
    if (wanted <= 0) return;
    const door = this.#doorX();
    const candidates = this.#figures
      .filter((p) => p.state !== 'boarding' && !p.exiting && p.x > 0 && p.x < this.#width)
      .sort((a, b) => Math.abs(a.x - door) - Math.abs(b.x - door))
      .slice(0, wanted);

    for (const p of candidates) {
      p.state = 'boarding';
      p.pauseMs = 0;
      p.targetX = door + (this.#rand() - 0.5) * this.#width * 0.05;
      p.targetFeetY = this.#height * LAYOUT.boardingY;
      p.homeFeetY = p.feetY;
    }
  }

  /** Anyone who did not reach the door before the bus left goes back to waiting. */
  #releaseBoarders() {
    for (const p of this.#figures) {
      if (p.state !== 'boarding') continue;
      p.state = 'walking';
      p.targetFeetY = p.homeFeetY ?? p.feetY;
      p.dir = this.#rand() < 0.5 ? -1 : 1;
    }
  }

  #advanceFigures(dt) {
    const secs = dt / 1000;
    const keep = [];

    for (const p of this.#figures) {
      if (p.state === 'boarding') {
        // Walk to the door and shrink with depth as they move up the platform.
        const dx = p.targetX - p.x;
        const dy = p.targetFeetY - p.feetY;
        const dist = Math.hypot(dx, dy);
        const speed = p.speed * 1.25;
        if (dist < Math.max(2, speed * secs)) {
          this.#boardedTotal += 1;
          continue; // stepped aboard; no longer in frame
        }
        p.x += (dx / dist) * speed * secs;
        p.feetY += (dy / dist) * speed * secs;
        p.h = this.#heightForFeetY(p.feetY, p.heightJitter);
        p.dir = dx >= 0 ? 1 : -1;
        p.phase += secs * p.stride;
        keep.push(p);
        continue;
      }

      if (p.pauseMs > 0) {
        // Standing still. Waiting passengers do this constantly, and it is the
        // case that punishes a background model updated indiscriminately.
        p.pauseMs -= dt;
        keep.push(p);
        continue;
      }

      p.x += p.dir * p.speed * secs;
      p.phase += secs * p.stride;

      // Pause only while comfortably inside the frame, so nobody loiters
      // half-visible on the boundary where ground truth is least meaningful.
      const inner = p.x > this.#width * 0.08 && p.x < this.#width * 0.92;
      if (!p.exiting && inner && this.#rand() < 0.12 * secs) {
        p.pauseMs = 900 + this.#rand() * 2500;
      }

      const margin = p.h * FIGURE_W_RATIO;
      if (p.x < -margin || p.x > this.#width + margin) {
        this.#departedTotal += 1;
        continue; // walked out of shot
      }
      keep.push(p);
    }

    this.#figures = keep;
  }

  #managePopulation(dt) {
    if (this.#elapsedMs < CALIBRATION_HOLD_MS) return;

    const present = this.#figures.filter((p) => !p.exiting).length;

    if (present < this.#target && this.#figures.length < MAX_FIGURES) {
      this.#spawnTimerMs -= dt;
      if (this.#spawnTimerMs <= 0) {
        // Fill a large deficit briskly, then settle into a natural trickle.
        const deficit = this.#target - present;
        this.#spawnTimerMs = deficit > 5 ? 140 : 340;
        this.#spawn();
      }
      return;
    }

    if (present > this.#target) {
      // Send the surplus towards whichever edge is closer rather than deleting
      // them, so the drop in count is something the detector can actually see.
      const surplus = this.#figures
        .filter((p) => !p.exiting && p.state !== 'boarding')
        .sort((a, b) => this.#edgeDistance(a) - this.#edgeDistance(b))
        .slice(0, present - this.#target);
      for (const p of surplus) {
        p.exiting = true;
        p.pauseMs = 0;
        p.dir = p.x < this.#width / 2 ? -1 : 1;
      }
    }
  }

  #edgeDistance(p) {
    return Math.min(p.x, this.#width - p.x);
  }

  #heightForFeetY(feetY, jitter) {
    const top = this.#height * LAYOUT.bandTop;
    const bottom = this.#height * LAYOUT.bandBottom;
    const depth = clamp((feetY - top) / (bottom - top), 0, 1);
    return this.#height * lerp(FIGURE_H_FAR, FIGURE_H_NEAR, depth) * jitter;
  }

  #spawn() {
    const r = this.#rand;
    const top = this.#height * LAYOUT.bandTop;
    const bottom = this.#height * LAYOUT.bandBottom;
    const depth = r();
    const feetY = lerp(top, bottom, depth);
    const jitter = 0.92 + r() * 0.16;   // people are not all the same height
    const h = this.#heightForFeetY(feetY, jitter);
    const dir = r() < 0.5 ? 1 : -1;
    const margin = h * FIGURE_W_RATIO * 0.6;

    this.#figures.push({
      id: this.#nextFigureId++,
      x: dir === 1 ? -margin : this.#width + margin,
      feetY,
      h,
      heightJitter: jitter,
      dir,
      // Nearer figures cover more pixels per second for the same walking pace.
      speed: lerp(0.05, 0.095, depth) * this.#width * (0.8 + r() * 0.45),
      stride: 6 + r() * 3,
      phase: r() * Math.PI * 2,
      pauseMs: 0,
      state: 'walking',
      exiting: false,
      coat: COAT_COLOURS[Math.floor(r() * COAT_COLOURS.length)],
      trousers: TROUSER_COLOURS[Math.floor(r() * TROUSER_COLOURS.length)],
      hair: HAIR_COLOURS[Math.floor(r() * HAIR_COLOURS.length)],
      targetX: 0,
      targetFeetY: feetY,
      homeFeetY: feetY,
    });
  }

  /** Fixed blemishes on the platform, rolled once per reset. */
  #rollGrime() {
    const r = this.#rand;
    const n = 90;
    this.#grime = [];
    for (let i = 0; i < n; i += 1) {
      this.#grime.push({
        x: r() * this.#width,
        y: this.#height * LAYOUT.roadBottom + r() * this.#height * (1 - LAYOUT.roadBottom),
        rx: 1 + r() * 3.5,
        ry: 0.6 + r() * 1.6,
        a: 0.03 + r() * 0.05,
      });
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  /**
   * Render one frame: background, then the bus, then pedestrians sorted so
   * nearer figures paint over farther ones.
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    this.drawBackground(ctx);
    this.drawBus(ctx);

    const order = [...this.#figures].sort((a, b) => a.feetY - b.feetY);
    for (const p of order) this.#drawFigure(ctx, p);
  }

  /**
   * The empty platform, with no pedestrians and no bus.
   *
   * Public because this is the honest way to calibrate the detector: render this
   * for a dozen frames and feed them in before the scene starts moving, and the
   * background model is seeded from a true reference frame rather than from
   * whatever happened to be standing there.
   *
   * @param {CanvasRenderingContext2D} ctx
   */
  drawBackground(ctx) {
    const W = this.#width;
    const H = this.#height;

    // Station wall behind the kerb.
    ctx.fillStyle = '#5f6772';
    ctx.fillRect(0, 0, W, H * LAYOUT.wallBottom);
    ctx.fillStyle = '#535a64';
    for (let x = 0; x < W; x += Math.max(24, W / 16)) {
      ctx.fillRect(x, H * 0.05, Math.max(10, W / 40), H * 0.11);
    }

    // Carriageway the bus stops on.
    ctx.fillStyle = '#6e747c';
    ctx.fillRect(0, H * LAYOUT.wallBottom, W, H * (LAYOUT.roadBottom - LAYOUT.wallBottom));
    ctx.fillStyle = '#b9bec4';
    const dash = W / 26;
    for (let x = 0; x < W; x += dash * 2) {
      ctx.fillRect(x, H * 0.245, dash, Math.max(1, H * 0.007));
    }

    // Platform, lighter towards the camera so depth reads without a projection.
    const grad = ctx.createLinearGradient(0, H * LAYOUT.roadBottom, 0, H);
    grad.addColorStop(0, '#83878d');
    grad.addColorStop(1, '#989ca2');
    ctx.fillStyle = grad;
    ctx.fillRect(0, H * LAYOUT.roadBottom, W, H * (1 - LAYOUT.roadBottom));

    // Kerb edge and tactile safety line.
    ctx.fillStyle = '#a9aeb4';
    ctx.fillRect(0, H * LAYOUT.roadBottom, W, Math.max(2, H * 0.014));
    ctx.fillStyle = '#c9a63e';
    ctx.fillRect(0, H * 0.325, W, Math.max(2, H * 0.011));

    // Paving joints. Static geometry, so the background model absorbs them.
    ctx.fillStyle = 'rgba(60,64,70,0.18)';
    for (let i = 1; i < 7; i += 1) {
      const y = H * (LAYOUT.roadBottom + 0.09 * i);
      if (y > H) break;
      ctx.fillRect(0, y, W, 1);
    }

    this.#drawShelter(ctx);

    ctx.fillStyle = '#3d4149';
    for (const g of this.#grime) {
      ctx.globalAlpha = g.a;
      ctx.beginPath();
      ctx.ellipse(g.x, g.y, g.rx, g.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  #drawShelter(ctx) {
    const W = this.#width;
    const H = this.#height;
    const x0 = W * 0.58;
    const x1 = W * 0.97;

    ctx.fillStyle = '#7f8b96';
    ctx.fillRect(x0, H * 0.455, x1 - x0, H * 0.235);   // glazing
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(x0, H * 0.455, x1 - x0, H * 0.06);
    ctx.fillStyle = '#3f4854';
    ctx.fillRect(x0 - W * 0.012, H * 0.40, (x1 - x0) + W * 0.024, H * 0.055); // roof
    ctx.fillStyle = '#2f3640';
    for (const px of [x0, (x0 + x1) / 2, x1 - W * 0.012]) {
      ctx.fillRect(px, H * 0.455, Math.max(2, W * 0.012), H * 0.265);         // posts
    }
    ctx.fillStyle = '#4b535e';
    ctx.fillRect(x0 + W * 0.03, H * 0.63, (x1 - x0) - W * 0.06, H * 0.022);   // bench
  }

  /**
   * The bus, when one is at the stop.
   *
   * Note for the detector: this is a large moving object that background
   * subtraction cannot help but flag as foreground. It is rejected downstream on
   * shape, not hidden here — a bus blob is wide and flat where a standing person
   * is tall and narrow, and the aspect-ratio filter in detector.js throws it out
   * on exactly that basis. Leaving it in the footage is the point; a crowd
   * detector that cannot tell a person from a bus is not much use.
   *
   * @param {CanvasRenderingContext2D} ctx
   */
  drawBus(ctx) {
    if (this.#busPhase === 'absent') return;

    const W = this.#width;
    const H = this.#height;
    const x = this.#busX;
    const busW = W * 0.62;
    const top = H * LAYOUT.busBodyTop;
    const bodyH = H * (LAYOUT.busBodyBottom - LAYOUT.busBodyTop);

    // Shadow on the carriageway.
    ctx.fillStyle = 'rgba(40,44,50,0.28)';
    ctx.fillRect(x + busW * 0.02, H * LAYOUT.busBodyBottom, busW * 0.96, H * 0.018);

    ctx.fillStyle = '#e6b422';
    ctx.fillRect(x, top, busW, bodyH);
    ctx.fillStyle = '#c99a15';
    ctx.fillRect(x, top + bodyH * 0.82, busW, bodyH * 0.18);

    // Glazing.
    ctx.fillStyle = '#2c3644';
    const winY = top + bodyH * 0.16;
    const winH = bodyH * 0.42;
    ctx.fillRect(x + busW * 0.04, winY, busW * 0.30, winH);
    ctx.fillRect(x + busW * 0.375, winY, busW * 0.24, winH);
    ctx.fillRect(x + busW * 0.86, winY, busW * 0.11, winH);

    // Door, on the side the boarding party walks towards.
    ctx.fillStyle = '#1f2732';
    ctx.fillRect(x + busW * 0.66, winY, busW * 0.16, bodyH * 0.78);
    ctx.fillStyle = '#39424f';
    ctx.fillRect(x + busW * 0.735, winY, Math.max(1, busW * 0.006), bodyH * 0.78);

    // Route blind.
    ctx.fillStyle = '#12161c';
    ctx.fillRect(x + busW * 0.04, top + bodyH * 0.04, busW * 0.22, bodyH * 0.10);

    ctx.fillStyle = '#1a1d22';
    for (const f of [0.16, 0.74]) {
      ctx.beginPath();
      ctx.arc(x + busW * f, H * LAYOUT.busBodyBottom + H * 0.008, H * 0.026, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * One pedestrian: head, torso, arms, legs, and a faint contact shadow.
   *
   * The shadow is deliberately weak. At 16% opacity it darkens the platform by
   * roughly 18 levels — under the detector's 25-level threshold — so it grounds
   * the figure visually without smearing into the foreground mask or bridging
   * two people who happen to pass close by.
   */
  #drawFigure(ctx, p) {
    const h = p.h;
    const w = h * FIGURE_W_RATIO;
    const x = p.x;
    const walking = p.pauseMs <= 0;
    const bob = walking ? Math.sin(p.phase) * h * 0.012 : 0;
    const fy = p.feetY + bob;

    ctx.fillStyle = 'rgba(30,34,40,0.16)';
    ctx.beginPath();
    ctx.ellipse(x, p.feetY + h * 0.012, w * 0.55, Math.max(0.8, h * 0.035), 0, 0, Math.PI * 2);
    ctx.fill();

    const swing = walking ? Math.sin(p.phase) * w * 0.20 : 0;
    const legW = w * 0.22;
    ctx.fillStyle = p.trousers;
    ctx.fillRect(x - w * 0.24 - legW / 2 + swing, fy - h * 0.32, legW, h * 0.32);
    ctx.fillRect(x + w * 0.24 - legW / 2 - swing, fy - h * 0.32, legW, h * 0.32);

    ctx.fillStyle = p.coat;
    const armW = w * 0.16;
    ctx.fillRect(x - w * 0.49, fy - h * 0.66, armW, h * 0.28);
    ctx.fillRect(x + w * 0.49 - armW, fy - h * 0.66, armW, h * 0.28);
    const torsoW = w * 0.62;
    ctx.fillRect(x - torsoW / 2, fy - h * 0.70, torsoW, h * 0.38);

    // Head overlaps the shoulders by 0.07h. That overlap is what keeps head and
    // torso a single connected component after the detector's 3x3 erosion; at
    // the smallest figure sizes a realistic neck would be eroded through and the
    // same person would be labelled twice.
    ctx.fillStyle = p.hair;
    ctx.beginPath();
    ctx.arc(x, fy - h * 0.76, h * 0.13, 0, Math.PI * 2);
    ctx.fill();
  }
}
