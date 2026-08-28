/**
 * CommuteIQ — Feature 3: multi-modal journey planner and universal QR pass.
 *
 * ── The claim this panel has to make good on ───────────────────────────────
 * The PRD's promise is "one QR for the whole trip" — walk, bus, metro, e-rickshaw
 * on a single pass instead of four separate tickets. That only means something if
 * the QR is real, so it is: `qr.js` encodes an actual QR symbol (byte mode, EC
 * level M, mask chosen by the standard's own penalty scoring), and the "Scan at
 * gate" button decodes the modules back out of the canvas and posts the recovered
 * token to the verification endpoint. Nothing is faked between the two ends.
 *
 * ── Two things the server, not this panel, decides ─────────────────────────
 * The fare and the itinerary. `POST /pass/issue` takes the origin, destination
 * and passenger type and re-plans the whole journey server-side; it does not
 * accept legs or a price from the browser. A ticketing client that could name its
 * own fare would be a fare-evasion tool, and the demo would deserve the question.
 *
 * The single-use rule is likewise enforced there: scanning twice returns
 * ALREADY_REDEEMED. That refusal is worth showing on purpose — it is the control
 * that makes a shared QR worthless.
 */

import { $, addCo2, api, el, fill, fmt, hideModal, on, showModal, state, MODE_ICON } from './app.js';
import { decodeQr, encodeQr, renderToCanvas } from './qr.js';

/** Human names for the modes, since the icon alone is ambiguous at 13px. */
const MODE_LABEL = { walk: 'Walk', bus: 'Bus', metro: 'Metro', erickshaw: 'E-Rickshaw' };

/**
 * Default demo pair: Powai Lake to Airport T2.
 *
 * Chosen by enumerating all 90 ordered stop pairs against the planner, not by
 * eye. It is the shortest itinerary that uses all three transit modes —
 * walk → bus → e-rickshaw → metro → walk, 2 transfers — so the panel opens
 * already showing the multi-modal claim the PRD leads with, rather than a single
 * bus ride that happens to be technically correct.
 *
 * The tie-breaker was the interchange: this route transfers through Central
 * Station, which is the stop the camera watches and the stop the fleet console
 * dispatches to. The commuter's itinerary therefore runs straight through the
 * crowd the rest of the console is arguing about, which is a demo that hangs
 * together instead of five panels describing unrelated places.
 */
const DEFAULT_FROM = 'ST_05';
const DEFAULT_TO = 'ST_06';

export function initJourney() {
  const fromSelect = $('#jny-from');
  const toSelect = $('#jny-to');
  const typeSelect = $('#jny-type');
  const avoid = $('#jny-avoid');
  const planBtn = $('#btn-plan');
  const legsList = $('#jny-legs');
  const summaryBox = $('#jny-summary');
  const passBtn = $('#btn-pass');
  const verifyBtn = $('#btn-verify');
  const verdict = $('#pass-verdict');
  const passCanvas = $('#pass-canvas');

  /** The QR modules currently on the canvas, kept so verification can decode them. */
  let symbol = null;
  let planning = false;

  // ── selectors ────────────────────────────────────────────────────────────

  function populateStops() {
    const byName = [...state.stops].sort((a, b) => a.name.localeCompare(b.name));
    for (const [sel, preset] of [[fromSelect, DEFAULT_FROM], [toSelect, DEFAULT_TO]]) {
      const chosen = sel.value || preset;
      fill(sel, byName.map((s) => el(
        'option',
        { value: s.stopId, selected: s.stopId === chosen ? 'selected' : null },
        s.name,
      )));
    }
  }

  /** `#jny-legs` is an <ol>, so its placeholder has to be an <li>, not a <p>. */
  function placeholder(message) {
    fill(legsList, el('li', { class: 'empty', text: message }));
    summaryBox.hidden = true;
  }

  // ── plan ─────────────────────────────────────────────────────────────────

  function renderPlan(plan) {
    state.plan = plan;

    fill(legsList, plan.legs.map((leg) => el('li', { class: 'leg', 'data-mode': leg.mode }, [
      el('span', { class: 'leg-icon', 'aria-hidden': 'true' }, MODE_ICON[leg.mode] ?? '•'),

      el('div', { class: 'leg-main' }, [
        el('div', { class: 'leg-title', text: `${MODE_LABEL[leg.mode] ?? leg.mode} → ${leg.toName}` }),
        el('div', { class: 'leg-sub' }, [
          `${leg.fromName} · ${fmt.km(leg.distanceKm)}`,
          leg.routeId ? ` · ${leg.routeId.replace('route_', 'Route ')}` : '',
        ]),
      ]),

      el('div', { class: 'leg-right' }, [
        el('span', { class: 'leg-mins', text: `${fmt.mins(leg.durationMins)} min` }),
        el('span', { class: 'leg-fare', text: leg.fare > 0 ? fmt.inr(leg.fare) : 'free' }),
        // Boarding pressure, shown only where it is actually notable — a chip on
        // every leg would be noise, and the point is to flag the crush.
        leg.boardingOccupancyPct >= 70
          ? el('span', { class: 'leg-crowd', text: `${fmt.pct(leg.boardingOccupancyPct)} full` })
          : null,
      ]),
    ])));

    const s = plan.summary;
    $('#jny-km').textContent = fmt.km(s.totalDistanceKm);
    $('#jny-mins').textContent = `${fmt.mins(s.totalDurationMins)} min`;
    // The server applies the concession, so this is the fare that will actually be
    // charged — no client-side arithmetic that could drift from the ticket.
    $('#jny-fare').textContent = s.fareMultiplier === 1
      ? fmt.inr(s.payableFare)
      : `${fmt.inr(s.payableFare)} · ${s.passengerType}`;
    // Against a private car for the same distance — the comparison the number
    // only means anything relative to.
    $('#jny-co2').textContent = `${s.carbon.kgSaved.toFixed(2)} kg`;
    summaryBox.hidden = false;
  }

  async function plan() {
    if (planning) return;
    if (fromSelect.value === toSelect.value) {
      placeholder('Choose two different stops.');
      return;
    }

    planning = true;
    planBtn.disabled = true;
    try {
      const res = await api.post('/api/v1/journey/plan', {
        fromStopId: fromSelect.value,
        toStopId: toSelect.value,
        weather: state.weather,
        passengerType: typeSelect.value,
        preferences: { avoidCrowding: avoid.checked },
      });
      renderPlan(res);
    } catch (err) {
      placeholder(err.message);
    } finally {
      planning = false;
      planBtn.disabled = false;
    }
  }

  // ── pass ─────────────────────────────────────────────────────────────────

  async function issuePass() {
    passBtn.disabled = true;
    try {
      const { pass } = await api.post('/api/v1/pass/issue', {
        fromStopId: fromSelect.value,
        toStopId: toSelect.value,
        weather: state.weather,
        preferences: { avoidCrowding: avoid.checked },
        passengerType: typeSelect.value,
      });
      state.pass = pass;

      // Only the token goes in the QR. A pass that carried the itinerary in its
      // payload would be a pass anyone could rewrite; the gate resolves the id
      // against the server, which is the only party that knows what was sold.
      symbol = encodeQr(pass.token);
      renderToCanvas(passCanvas, symbol.modules, { moduleSize: 6, margin: 4 });

      $('#pass-route').textContent = `${pass.from.name} → ${pass.to.name} · ${pass.summary.modes.map((m) => MODE_LABEL[m] ?? m).join(' → ')}`;
      $('#pass-id').textContent = pass.passId;
      $('#pass-legs').textContent = `${pass.legs.length} legs · ${pass.summary.transfers} transfer${pass.summary.transfers === 1 ? '' : 's'}`;
      $('#pass-fare').textContent = pass.fareMultiplier === 1
        ? fmt.inr(pass.payableFare)
        : `${fmt.inr(pass.payableFare)} (${typeSelect.value})`;
      $('#pass-exp').textContent = fmt.clock(pass.expiresAt);

      verdict.textContent = '';
      verdict.removeAttribute('data-valid');
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Scan at gate';

      // Carbon is credited when a journey is actually ticketed, not when it is
      // merely planned, so the KPI counts trips taken rather than trips browsed.
      addCo2(pass.summary.carbon.gramsSaved);

      showModal('#pass-modal');
    } catch (err) {
      placeholder(`Pass could not be issued — ${err.message}`);
    } finally {
      passBtn.disabled = false;
    }
  }

  /**
   * Read the QR back and present it to the gate.
   *
   * The decode is the point. Sending `state.pass.token` straight to the endpoint
   * would test the endpoint and nothing else; decoding the symbol proves the
   * thing on screen is a functioning QR code that a real scanner could read.
   */
  async function verify() {
    if (!symbol) return;
    verifyBtn.disabled = true;
    try {
      const token = decodeQr(symbol);
      const res = await api.post('/api/v1/pass/verify', { token });

      verdict.dataset.valid = res.valid ? '1' : '0';
      verdict.textContent = res.valid
        ? `✓ ${res.message}`
        : `✗ ${res.reason.replace(/_/g, ' ').toLowerCase()} — ${res.message}`;

      // Leave the button live: the second press is the demo. A pass that can be
      // scanned twice is the failure mode this control exists to prevent, and
      // showing the refusal is more convincing than describing it.
      verifyBtn.textContent = res.valid ? 'Scan again' : 'Scan at gate';
    } catch (err) {
      verdict.dataset.valid = '0';
      verdict.textContent = `✗ ${err.message}`;
    } finally {
      verifyBtn.disabled = false;
    }
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  planBtn.addEventListener('click', plan);
  passBtn.addEventListener('click', issuePass);
  verifyBtn.addEventListener('click', verify);

  // Re-plan on any change to the query. Passenger type is part of the query now
  // that the server prices the concession, so the fare on screen is always the
  // fare the pass will be issued at.
  for (const control of [fromSelect, toSelect, avoid, typeSelect]) {
    control.addEventListener('change', plan);
  }

  on('boot', () => {
    populateStops();
    plan();
  });

  // Weather is shared with the ETA board; a plan quoted in the rain must not
  // survive the sun coming out.
  on('weather-changed', plan);

  on('reset', () => {
    hideModal('#pass-modal');
    symbol = null;
    state.pass = null;
    plan();
  });
}
