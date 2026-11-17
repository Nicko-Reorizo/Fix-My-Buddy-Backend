import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAuthRouter } from './authRoutes.js';
import { createSession } from '../middleware/security.js';
import { hashPassword } from '../utils/crypto.js';

async function fixture(t, role = 'customer') {
  const calls = [];
  const row = { id: 'account-1', name: 'Test User', email: 'test@example.test', phone: '+639171234567', role, phone_verified: false, password_hash: await hashPassword('Password123') };
  const runQuery = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT * FROM users')) return { rows: [{ ...row }] };
    if (sql.startsWith('INSERT INTO users')) return { rows: [{ ...row, role: values[0], phone_verified: true }] };
    return { rows: [] };
  };
  const router = createAuthRouter({ role: role === 'mechanic' ? role : undefined, runQuery, transaction: fn => fn({ query: runQuery }), session: (res, req, user, exec = runQuery) => createSession(res, req, user, exec) });
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { calls, post };
}

test('signup immediately creates an auto-verified account and HttpOnly session without OTP', async t => {
  const { calls, post } = await fixture(t, 'mechanic');
  const response = await post('/signup', { name: 'Test User', email: 'test@example.test', phone: '09171234567', password: 'Password123', acceptedTerms: true, role: 'customer' });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.user.role, 'mechanic'); assert.equal(data.user.phoneVerified, true); assert.equal(data.challenge, undefined);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.ok(calls.some(call => call.sql.startsWith('INSERT INTO mechanic_profiles')));
  assert.ok(calls.some(call => call.sql.startsWith('INSERT INTO auth_sessions')));
  assert.ok(calls.every(call => !call.sql.includes('phone_challenges')));
});

test('password login issues a session, rejects wrong passwords and cross-role requests', async t => {
  const { post } = await fixture(t);
  let response = await post('/login', { email: 'test@example.test', password: 'Password123', role: 'customer' });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /fmb_session=/);
  assert.equal((await response.json()).user.phoneVerified, true);
  response = await post('/login', { email: 'test@example.test', password: 'Wrong123', role: 'customer' });
  assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
  response = await post('/login', { email: 'test@example.test', password: 'Password123', role: 'mechanic' });
  assert.equal(response.status, 403);
});

test('retired phone endpoints never issue a session', async t => {
  const { post } = await fixture(t);
  for (const path of ['/phone/start', '/phone/verify', '/phone/resend']) {
    const response = await post(path, { phone: '09171234567', code: '123456' });
    assert.equal(response.status, 410); assert.equal(response.headers.get('set-cookie'), null);
  }
});
