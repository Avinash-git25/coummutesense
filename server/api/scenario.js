/**
 * CommuteIQ — demo scenario control.
 *
 * ── Why an API for the demo timeline? ──────────────────────────────────────
 * The prototype's whole argument is a causal chain: Feature 1 sees a platform
 * fill up, and Feature 4 reacts by recommending an extra bus. Left to random
 * drift, that chain crosses the overcrowding threshold whenever the PRNG feels
 * like it — which is no good when the judges give you a few minutes and then ask
 * to see the interesting bit again.
 *
 * `server/sim.js` therefore runs the city on a scripted list of beats. This
 * module is the remote control for it: read the timeline, jump to any beat,
 * step forward, pause while you explain a panel, and reset to run the whole
 * story a second time. The presenter's keyboard shortcuts in the web console are
 * thin wrappers over POST /api/v1/scenario, so nothing about the demo depends on
 * waiting for the simulation to get round to the point being made.
 *
 * The beat list is exposed rather than hardcoded in the client, so the console's
 * timeline strip and the server can never disagree about how many beats there
 * are or what they are called. The beats' internal setpoints (`stopTarget`,
 * `earTarget`) are deliberately left out: they are how the simulation reaches a
 * state, not part of the state, and a client that read them would be tempted to
 * predict crowd numbers instead of reporting the ones it is sent.
 */

import { EVENTS } from '../bus.js';
import { badRequest } from '../http-error.js';

/** Accepted `action` values, in the order the presenter is likely to need them. */
const ACTIONS = ['jump', 'next', 'pause', 'resume', 'reset'];

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * The timeline as the console renders it: one entry per beat, positional index
 * included so the client never has to trust its own array ordering.
 * @param {{beats:Array<object>}} sim
 */
function beatList(sim) {
  return sim.beats.map((b, index) => ({
    index,
    key: b.key,
    label: b.label,
    durationMs: b.durationMs ?? null,
    awaitsOperator: Boolean(b.awaitsOperator),
  }));
}

/** A plain decimal integer, optionally signed. Nothing else counts as a beat. */
const DECIMAL_INT = /^[+-]?\d+$/;

/**
 * Coerce and range-check the `beat` field of a jump request.
 *
 * Accepts a numeric string as well as a number, because the value usually
 * arrives from a keypress or a data attribute and arithmetic on the client is
 * one more thing that can go wrong. Everything else is rejected: silently
 * clamping a bad index would move the demo somewhere the presenter did not ask
 * for, which is worse than an error they can see.
 *
 * Strings go through DECIMAL_INT rather than bare `Number()`, which is far too
 * generous here: `Number('  ')` is 0 and `Number('0x3')` is 3, so a blank or
 * malformed field would have jumped the demo somewhere plausible-looking
 * instead of reporting the mistake.
 *
 * @param {unknown} raw
 * @param {number} beatCount
 * @returns {number} a valid beat index
 */
function parseBeatIndex(raw, beatCount) {
  const max = beatCount - 1;
  const range = `0-${max}`;

  if (raw === undefined || raw === null || raw === '') {
    throw badRequest(`action 'jump' requires a 'beat' index in range ${range}`, {
      field: 'beat', minBeat: 0, maxBeat: max,
    });
  }

  const n =
    typeof raw === 'number' ? raw
      : typeof raw === 'string' && DECIMAL_INT.test(raw.trim()) ? Number(raw.trim())
        : NaN;
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw badRequest(`'beat' must be an integer in range ${range}, received ${JSON.stringify(raw)}`, {
      field: 'beat', minBeat: 0, maxBeat: max,
    });
  }
  return n;
}

// ── handlers ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/scenario — where the demo currently is, plus the full timeline.
 *
 * Polled once on page load; after that the console follows the SCENARIO events
 * the simulation publishes, so this exists mainly to bootstrap a tab that opened
 * mid-run or reconnected after the stream dropped.
 *
 * @param {{sim:object}} ctx
 * @returns {Promise<{success:true, scenario:object, beats:Array<object>}>}
 */
export async function scenarioState(ctx) {
  const { sim } = ctx;
  return {
    success: true,
    scenario: { ...sim.state() },
    beats: beatList(sim),
  };
}

/**
 * POST /api/v1/scenario — drive the timeline.
 *
 * Body: `{ action: 'jump'|'next'|'pause'|'resume'|'reset', beat?: number }`.
 *
 * Every action is idempotent by design. Pausing twice, or pressing `next` on the
 * terminal beat, returns the unchanged state rather than a conflict: a presenter
 * mashing a key mid-sentence should never be shown an error dialogue.
 *
 * @param {{body:object, sim:object, publish:Function, detectors:Map}} ctx
 * @returns {Promise<{success:true, action:string, scenario:object}>}
 */
export async function scenarioControl(ctx) {
  const { body, sim, publish, detectors } = ctx;

  const raw = body?.action;
  const action = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!ACTIONS.includes(action)) {
    throw badRequest(`unknown action ${JSON.stringify(raw ?? null)}; expected one of ${ACTIONS.join(', ')}`, {
      field: 'action', validActions: ACTIONS,
    });
  }

  let scenario;
  switch (action) {
    case 'jump':
      scenario = sim.jumpTo(parseBeatIndex(body.beat, sim.beats.length));
      break;

    case 'next':
      scenario = sim.next();
      break;

    case 'pause':
      scenario = sim.setPaused(true);
      break;

    case 'resume':
      scenario = sim.setPaused(false);
      break;

    case 'reset': {
      // Prefer a FULL reset when the host app offers one (server/index.js passes
      // `resetApp`). It re-seeds the store as well as rewinding the clock, which
      // is what "R" has to mean during a demo: the second run must not open with
      // the first run's issued passes, redeemed tickets and re-routed buses still
      // in place. `resetApp` clears the fatigue detectors and publishes RESET
      // itself, so there is nothing left for us to do here.
      if (typeof ctx.resetApp === 'function') {
        ctx.resetApp();
        scenario = sim.state();
        break;
      }

      // Fallback for a sim driven without the HTTP app around it (the test
      // suite): rewind the clock, PRNG and alert latches. The store keeps its
      // current crowd counts and eases them back toward beat zero over the next
      // few ticks.
      //
      // The per-vehicle fatigue detectors live outside the simulation (ctx owns
      // them, because the ingest endpoint feeds the same debounce), so
      // `sim.reset()` cannot clear them and we must. Skipping this leaves a
      // detector holding part of its 2s eye-closure window: the second run of
      // the demo would then raise DROWSINESS a few hundred milliseconds into
      // "City nominal", before the fatigue beat it is supposed to belong to.
      detectors?.clear();
      sim.reset();

      // Announce RESET too: it is the cue for panels to drop the sparkline
      // history and alert list they have accumulated — otherwise the second run
      // of the demo would open with the first run's alerts still on screen.
      publish(EVENTS.RESET, { at: new Date().toISOString(), via: 'scenario-api' });
      scenario = sim.state();
      break;
    }

    default:
      // Unreachable: `action` was checked against ACTIONS above. Kept explicit so
      // that adding an action to ACTIONS without a case here fails loudly instead
      // of silently resetting the demo mid-presentation.
      throw badRequest(`action '${action}' is listed but not implemented`, { field: 'action' });
  }

  return { success: true, action, scenario: { ...scenario } };
}
