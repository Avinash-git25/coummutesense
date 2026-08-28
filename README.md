# CommuteIQ

**Problem Statement 26205 — City Resources & Transit Pressure. SIH 2026.**

CommuteIQ is a transit-operations console for a city bus network: one screen where a
duty operator sees crowd pressure, arrival predictions, ticketing and driver safety at
once, and where a crowding event becomes a dispatch decision without leaving the page.
All five PRD features are implemented end to end — **(1)** passenger density from
computer vision on a platform camera, **(2)** predictive ETA that accounts for weather,
day-of-week and signal congestion, **(3)** multi-modal journey planning with a single
signed QR pass, **(4)** fleet stress monitoring with one-click re-routing of a spare
bus, and **(5)** driver telematics with sustained-eye-closure fatigue detection.
Feature 1 and Feature 4 are wired together: the camera's count is what triggers the
dispatch recommendation.

---

## Run it

```sh
node server/index.js
```

then open **http://localhost:3000**.

- **Node >= 22.5.0** is required. Storage is `node:sqlite`, which arrived in 22.5.
- **Zero npm dependencies.** There is no `dependencies` or `devDependencies` block in
  `package.json`, no `node_modules`, no install step and no build step. The server is
  `node:http` + `node:sqlite` + `node:crypto`; the console is plain ES modules served
  as static files.
- **Runs with the wifi off.** No CDN, no web font, no tile server, no model download —
  `grep -r http web/` finds nothing but the SVG namespace URI.

---

## The 90-second demo path

The city runs on a scripted timeline of six beats so the interesting part is
repeatable. Keyboard control, anywhere on the page:

| Key | Action |
|---|---|
| `1`–`6` | Jump straight to that beat |
| `Space` | Pause / resume the clock |
| `R` | Full reset — re-seeds the database, clears passes, rewinds the story |
| `?` | Key list |

| # | Beat | What to watch |
|---|---|---|
| 1 | City nominal | Panel 1: the count in the camera HUD is produced by the pipeline, not read from the server. Tick **FG mask** to see the raw foreground pixels the boxes came from; the **Accuracy ±1** stat is measured against the scene's own ground truth. |
| 2 | Crowd building at Central Station | Watch the platform fill and **Occupancy** climb toward 22 (ST_01's capacity). Panel 4's bars each carry a hairline at 85% — the PRD's dispatch trigger, drawn so a bar reads "past the line" rather than "quite high". |
| 3 | Overcrowding detected | **The money shot.** When the camera's count reaches 19 of 22 (86.36%, past >85%), the server pushes an `OVERCROWDING` alert over SSE. The alert rail beeps; Panel 4's dispatch console opens by itself and states *why* in numbers — which stop, at what percentage, which route serving it is most stressed, and that BUS_108 is idle with 40 seats. This beat waits for you. |
| 3→4 | One click | Press **Re-Route Bus**. The response reads `40 Seats Added` — computed from BUS_108's capacity — and route 104's load drops live, `88% → 59%`, `Critical → Moderate`. The "seats added" KPI in the header moves at the same instant. Click twice: the second click is idempotent and says `[replayed — no second bus was sent]`. |
| 5 | Driver fatigue on BUS_101 | The EAR trace in Panel 5 walks below the 0.21 threshold. Nothing fires yet — the progress bar fills for 2000 ms of *continuous* closure first, which is what stops every blink being an alert. Then `DROWSINESS ALERT`. Drag the **Fatigue simulator** slider to drive it by hand at any time; it POSTs real frames to `/api/v1/telematics/ingest`. |
| 6 | Network stable | EAR recovers, demand settles. Press `R` and the whole story runs again identically — the simulation's PRNG is seeded. |

Meanwhile, Panel 3: **Plan** with the default pair gives a Walk → Bus → Metro →
E-Rickshaw itinerary through Central Station, **Generate Pass** renders a real QR code,
and **Scan at gate** accepts it once and refuses the second scan.

**One honesty note about beat 3.** The trigger is meant to be driven by the camera, and
it is: the crossing to 19 comes from the browser detector's own count, POSTed to
`/api/v1/cv/ingest` twice a second. The scripted simulation raises the platform
population toward that point but cannot cross it on its own — it rounds the crowd to
whole people every 250 ms tick, and once ST_01 reaches 17 the per-tick easing step is
smaller than half a person, so the simulated count alone settles at 17 (77.3%,
`PREPARE_DISPATCH`). If you want the crossing on demand rather than on the detector's
timing, pin it:

```sh
curl -s localhost:3000/api/v1/cv/ingest \
  -H 'content-type: application/json' \
  -d '{"stopId":"ST_01","count":19}'
```

That is the identical endpoint and payload the browser uses, with the count fixed.

---

## What is real vs what is simulated

This is the section to read first. The prototype is built to be defended, not
demonstrated, so each claim below is narrower than the marketing version.

| Part | Status | Detail |
|---|---|---|
| **Passenger counting** | **Real computer vision** | A classical pipeline over raw canvas pixels, written out in full in `web/js/detector.js`: per-pixel running-average background model → absolute-difference threshold → morphological opening then closing (3×3 square) → 8-connected component labelling by explicit-stack flood fill → area/aspect/fill rejection → overlap-and-containment box merge → nearest-centroid tracking across frames. It runs in the browser, on-device. |
| **YOLOv8** | **Not running** | The TRD names YOLOv8. There is no neural network, no ONNX runtime and no weights anywhere in this repo: npm and PyPI are unreachable in this environment, so no inference runtime and no pretrained weights could be obtained. `detector.js` is the documented swap-in seam — the abstract `Detector` class with one method, `detect(imageData) -> {boxes, count, inferenceMs}`, is exactly what a YOLO/ONNX backend would implement, and it replaces `BackgroundSubtractionDetector` at one construction site in `web/js/cv.js` with no other file changing. |
| **The CCTV scene** | **Generated** | `web/js/scene.js` procedurally renders the platform, shelter, arriving bus and pedestrians from a fixed seed. That is deliberate rather than a shortcut: because the scene *knows* how many figures it drew (`groundTruthCount()`), and the detector is given no access to that number, the accuracy figure on screen is **measured** against known truth rather than asserted. A recorded video file would have no ground truth to measure against. |
| **QR pass** | **Real, both directions** | `web/js/qr.js` implements ISO/IEC 18004 by hand — GF(256) arithmetic, Reed–Solomon, block interleaving, module placement, format/version BCH codes, mask selection. Byte mode, EC level M, versions 1–10. It also contains a **decoder**, so the test suite can assert `decodeQr(encodeQr(s)) === s` — an encoder with a bad interleave still produces a plausible-looking square, and there is no scanner in CI. The token inside is HMAC-SHA256 signed (`server/api/pass.js`) and single-use: the first verify redeems it, the second is refused. |
| **ETA model** | **Real, explainable, not ML** | An additive model (`domain.estimateEta`) over base travel time, day-of-week factor, signal congestion score, weather penalty and boarding dwell. Every response carries the per-factor `breakdown` that produced the number, and it is shown on screen. Not a learned regression — there is no historical arrival dataset on the demo machine to train one on, and a single unexplained minute figure is the answer that cannot be defended. |
| **The map** | **Schematic** | Hand-drawn SVG, not Leaflet (which needs a package and a tile server, i.e. a network). Real Mumbai coordinates for all ten stops, but the projection fits each axis **independently** — the true bounding box is about twice as tall as wide — so it is **not to scale**, and the legend says `schematic · not to scale`. Geography is distorted; topology and live state are not. |
| **Vehicle movement, crowd build-up, EAR signal** | **Simulated** | `server/sim.js`, driven by a seeded mulberry32 PRNG at 250 ms ticks. Nothing calls `Math.random`, so every run of the demo is identical. |
| **Storage** | **In-memory SQLite, Mongo-shaped** | `node:sqlite` with a document-shaped table per collection — `_id TEXT PRIMARY KEY` plus a `doc` JSON column — behind a Mongo-flavoured `Collection` API. The TRD specified MongoDB; neither `mongod` nor Docker is on the demo machine, and a database that fails to start takes the demo with it. `server/db.js` is the single file a real Mongo driver would replace. The DB is `:memory:` and re-seeded from `data/seed/*.json` on every boot, which is also how `R` works. |

---

## Deliberate deviations from the TRD

Each of these is a place the spec was followed to a contradiction and a decision was
made instead of papered over.

**1. Count bands and the 85% trigger were in incompatible units.**
Feature 1 specifies crowding as a *count* (Low <5, Moderate 5–15, High >15). Feature 4
triggers overcrowding at *>85% capacity* — a ratio. A raw count cannot fire a
percentage rule, so the F1→F4 chain had no defined trigger at all. Bridged by giving
every stop and vehicle a `capacity` and deriving `occupancyPct = count / capacity * 100`.
Count bands remain the **human-facing stop label**; percentage bands drive **fleet
actions**. This reproduces the TRD's own worked example verbatim: ST_01 Central
Station, capacity 22, 19 waiting → `HIGH` (count band) → 86.36% → `CRITICAL` →
`DISPATCH_EXTRA_BUS`.

**2. `congestionIndex(88)` returns `"Critical"`, not the TRD's `"High"`.**
88% is past the same document's own >85% dispatch trigger. A load that *demands action*
should not share a label with one that only warrants watching, or the label stops
carrying information at the exact moment it matters.

**3. `"40 Seats Added"` is computed, not hardcoded.**
The TRD writes it as a literal string. `domain.capacityRelief(vehicle)` derives it from
the dispatched vehicle's own capacity and returns `{seatsAdded: 40, unit: 'seats',
text: '40 Seats Added'}` — a number the dashboard can do arithmetic on, alongside the
documented string. Dispatch the 32-seat BUS_111 instead and the message says 32.

**4. `drowsinessFlag` and `congestionIndex` are derived at read time and never stored.**
The TRD persists `earRatio` *and* `drowsinessFlag` side by side, and `currentDemand`
*and* `congestionIndex` side by side. Storing a signal next to a conclusion drawn from
it is a contradiction waiting for one careless write. For a safety feature the failure
mode is unacceptable in both directions: a console showing a drowsy driver whose eyes
are open, or an alert-looking driver who is asleep. Neither field is ever written.

**5. Socket.IO replaced by native Server-Sent Events.**
Feature 4 requires alerts *pushed* from Feature 1, but the TRD specifies only
request/response REST — there was no push channel in the spec. Everything that needs
pushing is server→client; commands travel back as ordinary POSTs. That is the shape SSE
was designed for, `EventSource` is built into the browser with automatic reconnection,
and it costs zero dependencies where Socket.IO costs a package we cannot install.
Channel: `GET /api/v1/events`, events `crowd` `alert` `reroute` `telematics` `fleet`
`scenario` `reset`.

**6. The fatigue rule is expressed in milliseconds, not frames.**
`EAR_THRESHOLD = 0.21`, `EAR_SUSTAINED_MS = 2000`. A bare `ear < threshold` check fires
on every blink (100–400 ms) and the alert becomes noise. It is deliberately *time* and
not a frame count because the same `DrowsinessDetector` runs against the server's 250 ms
telemetry ticks and against the browser at display frame rate — a frame count would
mean two different durations in the two places it is used.

**7. Stops are stored once, not embedded per route.**
The TRD's `routes` schema embeds full stop documents inline. Five routes serve ST_01, so
Central Station would exist five times and the copies would drift. Routes hold
`stopIds`; `model.hydrateRoute` re-embeds on read, so the response shape still matches
the documented one while exactly one stored copy exists.

**8. Guards and idempotency added to `/fleet/re-route`.**
The documented contract has none. Dispatching a vehicle that is in maintenance, or one
already on the target route, or the same dispatch twice because an operator
double-clicked, are all now refused or replayed with a stated reason. The refusal text
is shown verbatim in the console, because "BUS_112 is maintenance and cannot be
dispatched" is information and "something went wrong" is not.

---

## Privacy

**No frame, crop or image is ever transmitted or stored.** The detector runs in the
browser and only the *count* leaves the page. There is no endpoint anywhere in the API
that accepts an image.

The entire Feature 1 ingest payload is:

```json
{ "stopId": "ST_01", "count": 19, "groundTruth": 19,
  "source": "browser-cv", "frameId": "412", "inferenceMs": 3.4 }
```

Bounding boxes stay in the browser, used only to draw the overlay. Head regions are
blurred into the canvas *before* anything else is composited, so a face does not
survive a screenshot of the panel either — and the blur can be toggled so you can see
that it is really being applied. The stored `crowd_observations` document holds
`{stopId, count, capacity, source, observedAt}` and optionally `frameId` /
`inferenceMs`. Nothing per-person is retained: no identity, no track history, no
re-identification, no crop.

---

## API surface

Every route in the table below is the real routing table from `server/index.js`. All
responses carry `success`. Errors are `{success: false, error, ...extra}` with a real
status code.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/cv/crowd-stream?stopId=` | Crowd state for one stop (defaults to the busiest). **TRD contract.** |
| `GET` | `/api/v1/cv/stops` | Crowd state for every stop, busiest first, in one snapshot |
| `POST` | `/api/v1/cv/ingest` | Browser detector reports a frame's count; raises the overcrowding alert on the crossing |
| `GET` | `/api/v1/eta?stopId=&routeId=&weather=&day=` | Explainable arrival predictions with per-factor breakdown |
| `POST` | `/api/v1/journey/plan` | Multi-modal itinerary (Dijkstra over the seeded network), fare, CO₂ |
| `POST` | `/api/v1/pass/issue` | Issue a signed single-use pass. Fare is re-planned server-side |
| `POST` | `/api/v1/pass/verify` | Redeem a pass. `valid:false` + reason for expired / already-redeemed |
| `GET` | `/api/v1/pass?status=` | Issued passes, newest first |
| `GET` | `/api/v1/fleet/state` | Route stress, idle vehicles, network totals, recent dispatches |
| `POST` | `/api/v1/fleet/re-route` | Assign a vehicle to a demand-heavy route. **TRD contract.** |
| `POST` | `/api/v1/fleet/recall` | Send a vehicle back to its depot |
| `GET` | `/api/v1/telematics` | Every crewed vehicle, worst driver first |
| `GET` | `/api/v1/telematics/:vehicleId` | One driver's live state. `404` for uncrewed BUS_112 |
| `POST` | `/api/v1/telematics/ingest` | Accept one telemetry frame from the cab |
| `GET` | `/api/v1/routes` | Routes with stops re-embedded and `congestionIndex` derived |
| `GET` | `/api/v1/routes/:routeId` | One route, same shape |
| `GET` | `/api/v1/stops?mode=&routeId=` | Stops with live crowd state, busiest first |
| `GET` | `/api/v1/scenario` | Current beat plus the whole timeline |
| `POST` | `/api/v1/scenario` | `{action: jump\|next\|pause\|resume\|reset, beat?}` |
| `GET` | `/api/v1/events` | SSE stream (handled before routing) |
| `GET` | `/api/v1/health` | Uptime, SSE client count, collection sizes, scenario state |

### The two TRD-documented contracts

**Feature 1 — `GET /api/v1/cv/crowd-stream?stopId=ST_01`**

The four documented keys are returned verbatim and at the top level, unnested, so a
client written against the TRD keeps working. Everything after them is context the
dashboard needs — the TRD's response never says *which* stop the 19 people are at.

```json
{
  "success": true,
  "currentCount": 19,
  "densityStatus": "HIGH",
  "recommendedAction": "DISPATCH_EXTRA_BUS",

  "stopId": "ST_01",
  "stopName": "Central Station",
  "capacity": 22,
  "occupancyPct": 86.36,
  "occupancyBand": "CRITICAL",
  "observedAt": "2026-08-27T13:30:28.567Z",
  "source": "browser-cv"
}
```

**Feature 4 — `POST /api/v1/fleet/re-route`**

Request, exactly as the TRD documents it:

```json
{ "sourceRouteId": "route_102", "targetRouteId": "route_104", "vehicleId": "BUS_108" }
```

Response — `message` and `updatedCapacityRelief` are the documented keys, preserved
verbatim; `seatsAdded` is the same figure as a number, and `target` is the before/after
the console renders:

```json
{
  "success": true,
  "message": "BUS_108 successfully re-routed to Route 104.",
  "updatedCapacityRelief": "40 Seats Added",

  "requestId": "rr_…",
  "vehicleId": "BUS_108",
  "sourceRouteId": null,
  "targetRouteId": "route_104",
  "seatsAdded": 40,
  "capacityRelief": { "seatsAdded": 40, "unit": "seats", "text": "40 Seats Added" },
  "target": {
    "routeId": "route_104",
    "routeName": "Route 104 - City Center to Tech Hub",
    "demandBefore": 88, "demandAfter": 59.17,
    "congestionBefore": "Critical", "congestionAfter": "Moderate",
    "seatCapacityBefore": 80, "seatCapacityAfter": 120,
    "stillOvercrowded": false
  },
  "source": null,
  "at": "2026-08-27T13:30:28.601Z"
}
```

---

## Architecture

```
server/
  index.js        node:http server, ROUTES table, static files, SSE + health
  domain.js       SINGLE SOURCE OF TRUTH — every threshold, band and derived metric
  model.js        read-time views: stopCrowd, routeState, fleetState, telematicsView
  db.js           node:sqlite document store (_id + JSON doc), Mongo-swappable seam
  seed.js         loads data/seed/*.json on every boot; also backs the R reset
  sim.js          seeded PRNG scenario driver, the six BEATS, 250 ms ticks
  bus.js          in-process event bus + SSE fan-out
  http-error.js   HttpError -> status code mapping
  api/            one file per feature area; handlers are async (ctx) => body
web/
  index.html      the five panels, one <section> each
  css/app.css     no framework
  js/app.js       shared state, event bus, keyboard control, SSE transport
  js/detector.js  the CV pipeline + centroid tracker. No DOM — unit-testable
  js/scene.js     synthetic camera footage with exact ground truth. No DOM
  js/qr.js        ISO/IEC 18004 encoder AND decoder. DOM only in renderToCanvas
  js/{cv,map,eta,journey,fleet,telematics}.js   one dumb panel each
data/seed/        routes, stops, vehicles, drivers — the whole city, 4 JSON files
test/             node:test suites + the in-process HTTP harness
```

Panels never talk to each other. Everything crossing a panel boundary goes through the
event bus in `app.js`, whose event names mirror the server's — which is why the F1→F4
hand-off is one `on('alert')` subscription in `fleet.js` rather than a reference from
one panel into another, and why the same alert works whether it came from the browser
detector or the scenario driver.

---

## Testing

```sh
node --test test/*.test.js
```

Coverage: the domain rules (every band boundary, the ETA breakdown, fares, concessions,
carbon, haversine), the CV pipeline over frames built pixel by pixel where the number of
people is known by construction, the QR encoder against its own decoder, and the demo
path itself — the seed constants the story leans on (ST_01's capacity of 22, BUS_108's
40 seats), the F1→F4 chain, and the double-click idempotency guard.

Two things stated plainly rather than left to be discovered:

- **The suite runs in-process against a mock req/res**, not over a socket. This sandbox
  refuses to bind one — `listen` fails with `EPERM` on `0.0.0.0` and on `127.0.0.1` —
  so `test/harness.js` emits a synthetic `request` on the server object instead. That
  still exercises the real handler chain: routing, body parsing, the
  `HttpError`-to-status mapping and the JSON response shape. What it does **not** cover
  is the socket layer itself, keep-alive, and SSE streaming, since a mock response has
  no live connection to hold open. Those are verified by hand in the browser.
- **`npm test` is currently broken on Node 24.** The script is `node --test test/`, and
  on Node 24 a bare directory positional is treated as a file glob that matches the
  `test/` directory itself, which the runner then tries to execute as a test file
  (`Cannot find module …/test`). Use the command above, or plain `node --test`, until
  the script is changed to `node --test "test/**/*.test.js"`.

---

## Roadmap / not in scope

Named as absent rather than implied as present:

- **A real YOLOv8 or ONNX detector** behind the existing `Detector` interface, measured
  on the same generated frames so the classical baseline and the learned model are
  compared like for like.
- **Accessibility-aware routing** — step-free interchanges, ramp and lift availability
  per stop, as a planner preference alongside `avoidCrowding`.
- **A multilingual toggle.** All UI strings are currently English and inline.
- **A Next.js + Tailwind port** of the console, which is what the TRD names. The
  current one is hand-written ES modules because there is no build step and no registry.
- **A real MongoDB adapter** replacing `server/db.js`. The collection API is already
  Mongo-flavoured and the documents are stored in the TRD's schemas, so this is one
  file.
- **Persistence.** The database is `:memory:` on purpose; nothing survives a restart,
  which is the right trade for a demo and the wrong one for a deployment.
