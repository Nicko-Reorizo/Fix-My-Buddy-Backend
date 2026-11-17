import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { isAllowedOrigin } from './origins.js';

function environment(t, overrides = {}) {
  const values = { NODE_ENV: 'production', FRONTEND_ORIGIN: '', VERCEL: '', VERCEL_URL: '', VERCEL_PROJECT_PRODUCTION_URL: '', VERCEL_BRANCH_URL: '', ...overrides };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('production accepts the request HTTPS origin and denies unrelated or malformed origins', t => {
  environment(t);
  const req = { headers: { host: 'fixmybuddy.example:8443' }, socket: {} };
  assert.equal(isAllowedOrigin('https://fixmybuddy.example:8443', req), true);
  for (const origin of ['https://other.example', 'https://fixmybuddy.example', 'http://fixmybuddy.example:8443', 'null', 'https://fixmybuddy.example:8443/path', 'https://user@fixmybuddy.example:8443', 'https://fixmybuddy.example:8443?value=1', 'https://fixmybuddy.example:8443\\', 'https://fixmybuddy.example:8443\n']) {
    assert.equal(isAllowedOrigin(origin, req), false, origin);
  }
  assert.equal(isAllowedOrigin(undefined, req), true);
});

test('explicit frontend origins permit separate frontend hosts without widening the allowlist', t => {
  environment(t, { FRONTEND_ORIGIN: ' https://customer.example/,https://mechanic.example ' });
  const req = { headers: { host: 'api.example' } };
  assert.equal(isAllowedOrigin('https://customer.example', req), true);
  assert.equal(isAllowedOrigin('https://mechanic.example', req), true);
  assert.equal(isAllowedOrigin('https://customer.example.attacker.test', req), false);
});

test('Vercel deployment environment hosts work without trusting forwarded headers', t => {
  environment(t, { VERCEL: '1', VERCEL_URL: 'fixmybuddy-preview.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'fixmybuddy.example', VERCEL_BRANCH_URL: 'fixmybuddy-main.vercel.app' });
  const req = { headers: { host: 'internal.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https', forwarded: 'host=attacker.example;proto=https' } };
  for (const origin of ['https://fixmybuddy-preview.vercel.app', 'https://fixmybuddy.example', 'https://fixmybuddy-main.vercel.app']) assert.equal(isAllowedOrigin(origin, req), true);
  assert.equal(isAllowedOrigin('https://attacker.example', req), false);
  assert.equal(isAllowedOrigin('http://fixmybuddy.example', req), false);
});

test('development retains localhost and LAN access while production denies remote localhost origins', t => {
  environment(t, { NODE_ENV: 'development' });
  assert.equal(isAllowedOrigin('http://192.168.1.2:5173'), true);
  assert.equal(isAllowedOrigin('http://localhost:5174'), true);
  assert.equal(isAllowedOrigin('https://unrelated.example'), false);
  process.env.NODE_ENV = 'production';
  assert.equal(isAllowedOrigin('http://localhost:5173', { headers: { host: 'fixmybuddy.example' } }), false);
});

test('production HTTP signup uses the shared origin policy for both workspaces', async t => {
  environment(t);
  const { createApp } = await import('../server.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const host = `127.0.0.1:${server.address().port}`;
  const post = (path, origin, extraHeaders = {}) => fetch(`http://${host}${path}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...extraHeaders }, body: '{}',
  });
  for (const path of ['/api/auth/signup', '/api/mechanics/auth/signup']) {
    const own = await post(path, `https://${host}`);
    assert.equal(own.status, 400); // Reaches form validation, with no database needed.
    assert.equal(own.headers.get('access-control-allow-origin'), `https://${host}`);
    assert.match(own.headers.get('vary'), /Origin/);
    const unrelated = await post(path, 'https://attacker.example', { 'x-forwarded-host': 'attacker.example' });
    assert.equal(unrelated.status, 403);
    assert.equal(unrelated.headers.get('access-control-allow-origin'), null);
  }
});

test('production tracking accepts its own HTTPS origin and rejects an unrelated origin', { timeout: 10000 }, async t => {
  environment(t);
  const [{ WebSocket }, { attachTrackingGateway }] = await Promise.all([import('ws'), import('../ws/gateway.js')]);
  const server = createServer();
  const detach = attachTrackingGateway(server, {
    authenticate: async () => ({ id: 'account-1' }),
    service: { snapshot: async () => ({ type: 'tracking:ready' }) },
    subscribe: () => () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`;
  const url = `ws://${host}/api/ws/tracking?bookingId=booking-1`;
  const own = new WebSocket(url, { origin: `https://${host}` });
  own.on('error', () => {});
  t.after(async () => { own.terminate(); detach(); await new Promise(resolve => server.close(resolve)); });
  const [raw] = await once(own, 'message');
  assert.equal(JSON.parse(raw).type, 'tracking:ready');
  const denied = new WebSocket(url, { origin: 'https://attacker.example' });
  denied.on('error', () => {});
  t.after(() => denied.terminate());
  const status = await new Promise(resolve => denied.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); }));
  assert.equal(status, 403);
});
