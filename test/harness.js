/**
 * In-process HTTP harness.
 *
 * This sandbox refuses to bind a socket — `listen` fails with EPERM on both
 * 0.0.0.0 and 127.0.0.1 — so the suite cannot start a server and fetch from it.
 * That is a constraint, not a preference, and it turns out to be a decent trade:
 * emitting a synthetic `request` on the server object exercises the real handler
 * chain (routing, body parsing, the HttpError-to-status mapping, the JSON shape)
 * without a network round trip, so the tests are both faster and reproducible.
 *
 * What it does NOT cover, stated plainly rather than left to be discovered: the
 * socket layer itself, keep-alive, and SSE streaming, since a mock response has
 * no real connection to hold open. Those are verified by hand in the browser.
 */

import { Readable } from 'node:stream';
import { createApp } from '../server/index.js';

/**
 * A minimal ServerResponse stand-in. Only the surface `server/index.js` actually
 * touches is implemented, so a change there that reaches for something new will
 * fail loudly here instead of silently passing.
 */
class MockResponse {
  #chunks = [];

  constructor(resolve) {
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.finished = false;
    this._resolve = resolve;
  }

  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }

  getHeader(name) { return this.headers[name.toLowerCase()]; }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }

  write(chunk) {
    this.headersSent = true;
    this.#chunks.push(String(chunk));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.headersSent = true;
    this.finished = true;
    const text = this.#chunks.join('');
    let json = null;
    try { json = JSON.parse(text); } catch { /* static asset or empty body */ }
    this._resolve({ status: this.statusCode, headers: this.headers, text, body: json });
    return this;
  }

  // The static file path pipes a stream into the response.
  on() { return this; }

  once() { return this; }

  emit() { return false; }
}

/**
 * Drive one request through the app.
 * @param {{server:import('node:http').Server}} app
 * @param {string} method
 * @param {string} path including any query string
 * @param {object} [body] JSON request body
 * @returns {Promise<{status:number, headers:object, text:string, body:any}>}
 */
export function call(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);

    const req = Readable.from(payload === null ? [] : [Buffer.from(payload)]);
    req.method = method;
    req.url = path;
    req.headers = {
      host: 'localhost:3000',
      ...(payload === null ? {} : {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      }),
    };

    const res = new MockResponse(resolve);
    // A timeout rather than an open-ended await: a handler that never responds is
    // a bug the suite should name, not one it should hang on.
    const timer = setTimeout(() => reject(new Error(`${method} ${path} never responded`)), 5000);
    const done = (r) => { clearTimeout(timer); resolve(r); };
    res._resolve = done;

    app.server.emit('request', req, res);
  });
}

export const get = (app, path) => call(app, 'GET', path);
export const post = (app, path, body) => call(app, 'POST', path, body ?? {});

/**
 * A fresh app with the scenario driver stopped.
 *
 * Every test that asserts on a number needs the world to hold still: with the sim
 * running, crowd counts and vehicle positions move between the setup and the
 * assertion, and the suite would fail intermittently for reasons that have
 * nothing to do with the code under test.
 */
export function freshApp() {
  return createApp({ location: ':memory:', startSim: false });
}
