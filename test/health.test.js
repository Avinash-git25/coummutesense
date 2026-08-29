import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { call, freshApp, get } from './harness.js';

describe('health and HTTP safety', () => {
  let app;

  before(() => { app = freshApp(); });
  after(() => { app.store.close(); });

  it('reports a seeded, healthy application snapshot', async () => {
    const response = await get(app, '/api/v1/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.status, 'ok');
    assert.equal(response.body.collections.routes, 5);
    assert.equal(response.body.collections.stops, 10);
    assert.equal(response.body.collections.vehicles, 12);
    assert.equal(response.body.collections.passes, 0);
  });

  it('adds browser safety headers to API responses', async () => {
    const response = await get(app, '/api/v1/health');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.match(response.headers['permissions-policy'], /camera=\(\)/);
  });

  it('returns a structured 400 for malformed JSON', async () => {
    const response = await call(app, 'POST', '/api/v1/cv/ingest', '{not-json');
    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error, 'request body is not valid JSON');
  });

  it('returns a structured 404 for unknown API routes', async () => {
    const response = await get(app, '/api/v1/does-not-exist');
    assert.equal(response.status, 404);
    assert.equal(response.body.success, false);
    assert.match(response.body.error, /no route/);
  });
});
