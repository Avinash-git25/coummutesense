/**
 * CommuteIQ — Feature 4: fleet stress heatmap and dispatch console.
 *
 * ── The chain this panel completes ─────────────────────────────────────────
 * Feature 1's camera counts a platform filling up and posts the count. The server
 * derives occupancy against that stop's capacity, and when it crosses 85% it
 * pushes an OVERCROWDING alert. This panel is what receives it: the dispatch
 * block opens, states *why* in numbers, pre-selects an idle bus with enough seats
 * to matter, and offers one button.
 *
 * Nothing here reaches into the CV panel. The hand-off is a subscription to an
 * event whose name is the server's own, which is why the same alert works whether
 * it came from the browser detector's ingest or from the scenario driver.
 *
 * ── Why the 85% line is drawn on every bar ────────────────────────────────
 * The PRD specifies the trigger as ">85% capacity" and then never shows it. A bar
 * at 88% and a bar at 71% look like "a lot" and "a fair amount" unless the
 * threshold is on screen, at which point they read as "past the line, act" and
 * "under the line, watch". The hairline in `.heat-bar::after` is that line. It is
 * the difference between a dashboard and a decision tool.
 */

import { $, api, el, fill, fmt, on, state } from './app.js';

/** Bar fill per stress band. */
const BAND_FILL = {
  NOMINAL: 'var(--ok)',
  ELEVATED: 'var(--warn)',
  HIGH: '#ff8a5c',
  CRITICAL: 'var(--crit)',
};

export function initFleet() {
  const heat = $('#fleet-heat');
  const idlePill = $('#fleet-idle');
  const empty = $('#dispatch-empty');
  const live = $('#dispatch-live');
  const why = $('#dispatch-why');
  const vehicleSelect = $('#dispatch-vehicle');
  const routeSelect = $('#dispatch-route');
  const button = $('#btn-reroute');
  const result = $('#dispatch-result');

  /**
   * The alert currently being acted on, if any.
   *
   * Held rather than re-derived from `state`, because the recommendation must not
   * change under the operator's cursor: if the crowd eases for one tick between
   * the alert appearing and the click landing, the button should still dispatch
   * the bus the operator was shown, not silently retarget.
   */
  let recommendation = null;

  /** Set on the first click so a double-click replays instead of double-dispatching. */
  let requestId = null;
  let busy = false;

  // ── heatmap ──────────────────────────────────────────────────────────────

  function renderHeat() {
    const routes = [...(state.routes ?? [])]
      .sort((a, b) => b.currentDemand - a.currentDemand);

    idlePill.textContent = `${state.fleet?.totals?.idleVehicles ?? 0} idle`;
    idlePill.dataset.state = (state.fleet?.totals?.idleVehicles ?? 0) === 0 ? 'warn' : 'ok';

    if (routes.length === 0) {
      fill(heat, el('p', { class: 'empty' }, 'Fleet state loading…'));
      return;
    }

    fill(heat, routes.map((r) => {
      const pct = Math.round(r.currentDemand);
      return el('div', { class: 'heat', 'data-band': r.stressBand }, [
        el('div', { class: 'heat-name', text: r.routeName }),
        // congestionIndex is the server's own word for this number. Showing the
        // label next to the percentage means the operator and the API agree.
        el('div', { class: 'heat-pct' }, `${pct}% · ${r.congestionIndex}`),

        el('div', { class: 'heat-bar' }, el('i', {
          style: `width:${Math.min(100, pct)}%;background:${BAND_FILL[r.stressBand] ?? 'var(--ok)'}`,
        })),

        el('div', { class: 'heat-meta' }, [
          el('span', {}, [el('b', { text: String(r.vehicles?.length ?? 0) }), ' buses']),
          el('span', {}, [el('b', { text: fmt.int(r.seatCapacity) }), ' seats']),
          el('span', {}, [el('b', { text: fmt.int(r.seatsFree) }), ' free']),
          el('span', {}, [el('b', { text: fmt.mins(r.headwayMins ?? 0) }), ' min headway']),
        ]),
      ]);
    }));
  }

  // ── dispatch recommendation ──────────────────────────────────────────────

  /**
   * Pick the idle bus to offer first: the largest one that is actually available.
   * Capacity relief is the point of the action, so the default should be the
   * option that relieves the most — the operator can override in the select.
   */
  function bestIdleVehicle() {
    return [...(state.fleet?.idleVehicles ?? [])]
      .sort((a, b) => b.capacity - a.capacity)[0] ?? null;
  }

  function populateDispatchControls(preferredRouteId) {
    const idle = [...(state.fleet?.idleVehicles ?? [])].sort((a, b) => b.capacity - a.capacity);

    fill(vehicleSelect, idle.length
      ? idle.map((v) => el('option', { value: v.vehicleId }, `${v.vehicleId} · ${v.capacity} seats`))
      : [el('option', { value: '' }, 'no idle vehicles')]);

    const routes = [...(state.routes ?? [])].sort((a, b) => b.currentDemand - a.currentDemand);
    fill(routeSelect, routes.map((r) => el(
      'option',
      { value: r.routeId, selected: r.routeId === preferredRouteId ? 'selected' : null },
      `${r.routeName.split(' - ')[0]} · ${Math.round(r.currentDemand)}%`,
    )));

    button.disabled = idle.length === 0;
  }

  /**
   * Open the dispatch block for an overcrowding alert.
   * @param {object} alert the OVERCROWDING payload from the server
   */
  function recommend(alert) {
    // The alert names the stop; the routes that serve it are the candidates. Take
    // the most stressed one, since that is where an added bus does the most good.
    const candidateIds = new Set(alert.routeIds ?? routesServing(alert.stopId));
    const candidate = [...(state.routes ?? [])]
      .filter((r) => candidateIds.size === 0 || candidateIds.has(r.routeId))
      .sort((a, b) => b.currentDemand - a.currentDemand)[0];

    const vehicle = bestIdleVehicle();
    recommendation = { alert, routeId: candidate?.routeId ?? null, vehicleId: vehicle?.vehicleId ?? null };
    requestId = null;

    fill(why, [
      el('b', { text: alert.stopName ?? alert.stopId }),
      ` is at ${fmt.pct(alert.occupancyPct)} of capacity (${alert.count}/${alert.capacity} waiting) — past the 85% dispatch trigger. `,
      candidate
        ? el('span', {}, `${candidate.routeName.split(' - ')[0]} is the most stressed route serving it at ${Math.round(candidate.currentDemand)}%. `)
        : null,
      vehicle
        ? el('span', {}, `${vehicle.vehicleId} is idle with ${vehicle.capacity} seats.`)
        : el('b', { text: 'No idle vehicle available — escalate to the depot.' }),
    ]);

    populateDispatchControls(recommendation.routeId);
    if (recommendation.vehicleId) vehicleSelect.value = recommendation.vehicleId;

    live.hidden = false;
    empty.hidden = true;
    button.classList.add('btn-urgent');
    result.textContent = '';
    result.removeAttribute('data-kind');
  }

  function closeRecommendation() {
    recommendation = null;
    requestId = null;
    live.hidden = true;
    empty.hidden = false;
    button.classList.remove('btn-urgent');
  }

  // ── the action ───────────────────────────────────────────────────────────

  button.addEventListener('click', async () => {
    if (busy) return;
    const vehicleId = vehicleSelect.value;
    const targetRouteId = routeSelect.value;
    if (!vehicleId || !targetRouteId) return;

    // One id per intent, reused on retry. The server keys its replay cache on it,
    // so an impatient second click during a live demo returns the first result
    // instead of dispatching a second bus.
    requestId ??= `${vehicleId}-${targetRouteId}-${Math.random().toString(36).slice(2, 10)}`;

    busy = true;
    button.disabled = true;
    button.textContent = 'Dispatching…';
    try {
      const res = await api.post('/api/v1/fleet/re-route', { vehicleId, targetRouteId, requestId });

      const t = res.target ?? {};
      result.dataset.kind = 'ok';
      fill(result, [
        el('b', { text: res.message }),
        ` ${res.updatedCapacityRelief}. `,
        t.demandBefore !== null && t.demandAfter !== null
          ? `Route load ${Math.round(t.demandBefore)}% → ${Math.round(t.demandAfter)}% (${t.congestionBefore} → ${t.congestionAfter}).`
          : '',
        res.replayed ? ' [replayed — no second bus was sent]' : '',
        t.stillOvercrowded ? el('b', { text: ' Still above trigger: consider a second unit.' }) : null,
      ]);

      // Only stand down when the action actually cleared the condition. A relief
      // that leaves the route over the line is not a finished job, and the panel
      // should keep offering the next dispatch.
      if (!t.stillOvercrowded) {
        button.classList.remove('btn-urgent');
        recommendation = null;
      }
    } catch (err) {
      result.dataset.kind = 'err';
      // Guards are shown verbatim: "BUS_108 is maintenance and cannot be
      // dispatched" is information, and hiding it behind "something went wrong"
      // would make the console useless in the one moment it matters.
      fill(result, [el('b', { text: 'Refused: ' }), err.message]);
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = 'Re-Route Bus';
      populateDispatchControls(routeSelect.value);
    }
  });

  // ── wiring ───────────────────────────────────────────────────────────────

  /** Route ids that actually serve a stop, from the shared network geography. */
  function routesServing(stopId) {
    return (state.network ?? [])
      .filter((r) => (r.stops ?? []).some((s) => s.stopId === stopId))
      .map((r) => r._id);
  }

  on('boot', () => {
    renderHeat();
    populateDispatchControls(null);

    // A tab opened mid-crisis should not sit on "nothing to do" until the next
    // alert happens to fire.
    const hot = state.fleet?.hottestStop;
    if (hot && hot.occupancyPct > 85) {
      recommend({
        kind: 'OVERCROWDING',
        stopId: hot.stopId,
        stopName: hot.name,
        count: hot.count,
        capacity: hot.capacity,
        occupancyPct: hot.occupancyPct,
        routeIds: routesServing(hot.stopId),
      });
    }
  });

  on('fleet', renderHeat);

  on('alert', (a) => {
    if (a.kind !== 'OVERCROWDING') return;
    // Do not clobber a recommendation already on screen with a fresh alert for
    // the same stop; the operator is mid-decision.
    if (recommendation && recommendation.alert.stopId === a.stopId) return;
    recommend(a);
  });

  on('reset', () => {
    closeRecommendation();
    result.textContent = '';
    renderHeat();
  });
}
