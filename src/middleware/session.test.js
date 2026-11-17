import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createSessionMiddleware, requireAuth, securityHeadersAndCsrf } from './security.js';

async function fixture(t, runQuery) {
  const app = express();
  app.use(securityHeadersAndCsrf(() => true));
  app.use(createSessionMiddleware({ runQuery }));
  app.get('/auth/session', (req, res) => res.json({ user: req.user }));
  app.get('/private', requireAuth(), (req, res) => res.json({ user: req.user }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return path => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { Cookie: 'fmb_session=test-session' } });
}

test('database interruption returns 503 without expiring a valid customer session, then recovers', async t => {
  let available = false;
  const get = await fixture(t, async () => {
    if (!available) throw new Error('connection reset');
    return { rows: [{ id: 'customer-1', role: 'customer', name: 'Customer' }] };
  });
  for (const path of ['/private', '/auth/session']) {
    const response = await get(path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  available = true;
  const recovered = await get('/private');
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).user.id, 'customer-1');
});

test('mechanic profile lookup failures cannot masquerade as expired sessions', async t => {
  const get = await fixture(t, async sql => {
    if (sql.includes('FROM mechanic_profiles')) throw new Error('connection reset');
    return { rows: [{ id: 'mechanic-1', role: 'mechanic', name: 'Mechanic' }] };
  });
  const response = await get('/private');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('actually missing or expired sessions still require authentication and are never cached', async t => {
  const get = await fixture(t, async () => ({ rows: [] }));
  const response = await get('/private');
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const check = await get('/auth/session');
  assert.deepEqual(await check.json(), { user: null });
  assert.equal(check.headers.get('cache-control'), 'private, no-store');
});

test('tracking authentication propagates temporary database failure as 503', async () => {
  const attachSession = createSessionMiddleware({ runQuery: async () => { throw new Error('offline'); } });
  await assert.rejects(attachSession({ headers: { cookie: 'fmb_session=test-session' } }, null, () => {}), error => error.status === 503);
});
