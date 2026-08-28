/**
 * CommuteIQ — in-process event bus and SSE fan-out.
 *
 * ── Why SSE and not Socket.IO / raw WebSockets? ────────────────────────────
 * PRD Feature 4 requires an "Instant Alert Notification when overcrowding is
 * PUSHED from Feature 1", but the TRD only specifies request/response REST, so
 * there was no push channel in the spec at all.
 *
 * Everything we need to push is server -> client (crowd updates, overcrowding
 * alerts, re-route confirmations, telematics frames, scenario beats). Commands
 * in the other direction are ordinary POSTs. That is exactly the shape
 * Server-Sent Events were designed for, and the browser has `EventSource`
 * built in — so we get automatic reconnection with zero dependencies, where
 * Socket.IO would need a package we cannot install.
 */

import { EventEmitter } from 'node:events';

/** Event names carried on the bus. */
export const EVENTS = {
  CROWD: 'crowd',           // a new crowd observation was ingested
  ALERT: 'alert',           // overcrowding / drowsiness / operational alert
  REROUTE: 'reroute',       // a vehicle was dispatched to another route
  TELEMATICS: 'telematics', // driver/vehicle telematics frame
  FLEET: 'fleet',           // fleet state changed (demand, capacity)
  SCENARIO: 'scenario',     // demo scenario advanced to a new beat
  RESET: 'reset',           // demo was reset to its initial state
};

export const bus = new EventEmitter();
// Many panels subscribe to the same events; the default limit of 10 is low.
bus.setMaxListeners(50);

/**
 * Publish an event to every connected SSE client.
 * @param {string} type one of EVENTS
 * @param {object} payload JSON-serialisable
 */
export function publish(type, payload = {}) {
  bus.emit(type, payload);
  bus.emit('*', { type, payload });
}

/** Monotonic id so clients can detect gaps; also used for SSE `id:` frames. */
let seq = 0;
export const nextSeq = () => ++seq;

/**
 * Tracks open SSE responses and broadcasts to all of them.
 *
 * A single `*` listener on the bus does the fan-out, rather than one listener
 * per client per event type, so connect/disconnect churn cannot leak listeners.
 */
export class SseHub {
  /** @type {Set<import('node:http').ServerResponse>} */
  #clients = new Set();
  #unsubscribe = null;

  start() {
    if (this.#unsubscribe) return;
    const onAny = ({ type, payload }) => this.#broadcast(type, payload);
    bus.on('*', onAny);
    this.#unsubscribe = () => bus.off('*', onAny);

    // Comment frames keep proxies and browsers from idling the stream out.
    this.heartbeat = setInterval(() => {
      for (const res of this.#clients) res.write(': ping\n\n');
    }, 15_000);
    this.heartbeat.unref?.();
  }

  stop() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    clearInterval(this.heartbeat);
    for (const res of this.#clients) res.end();
    this.#clients.clear();
  }

  /**
   * Attach a request as a long-lived SSE stream.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  add(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    this.#clients.add(res);

    const drop = () => { this.#clients.delete(res); };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);

    this.#send(res, EVENTS.SCENARIO, { hello: true, clients: this.#clients.size });
  }

  #broadcast(type, payload) {
    for (const res of this.#clients) this.#send(res, type, payload);
  }

  #send(res, type, payload) {
    try {
      res.write(`id: ${nextSeq()}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      this.#clients.delete(res); // client vanished mid-write
    }
  }

  get clientCount() { return this.#clients.size; }
}

export const sseHub = new SseHub();
