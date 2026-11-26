import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAuthRouter } from './authRoutes.js';
import { createSession } from '../middleware/security.js';
import { hashPassword } from '../utils/crypto.js';

async function fixture(t, role = 'customer', overrides = {}) {
  const calls = [];
  const row = { id: 'account-1', name: 'Test User', email: 'test@example.test', phone: '+639171234567', role, phone_verified: false, password_hash: await hashPassword('Password123') };
  const runQuery = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT * FROM users')) return { rows: [{ ...row }] };
    if (sql.startsWith('INSERT INTO users')) return { rows: [{ ...row, role: values[0], phone_verified: true }] };
    return { rows: [] };
  };
  const router = createAuthRouter({ role: role === 'mechanic' ? role : undefined, runQuery, transaction: fn => fn({ query: runQuery }), session: (res, req, user, exec = runQuery) => createSession(res, req, user, exec), ...overrides });
  const app = express(); app.use(express.json()); app.use(router);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = path => fetch(`http://127.0.0.1:${server.address().port}${path}`);
  return { calls, post, get };
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

const signupDetails = { name: 'Test User', email: 'test@example.test', phone: '09171234567', password: 'Password123', acceptedTerms: true };

test('customer signup normalizes input and preserves the public user and cookie contract', async t => {
  const { calls, post } = await fixture(t);
  const response = await post('/signup', { ...signupDetails, name: ' Test User ', email: ' TEST@EXAMPLE.TEST ' });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.deepEqual(Object.keys(data), ['user']);
  assert.equal(data.user.role, 'customer');
  assert.equal(data.user.password_hash, undefined);
  const insert = calls.find(call => call.sql.startsWith('INSERT INTO users'));
  assert.deepEqual(insert.values.slice(0, 4), ['customer', 'Test User', 'test@example.test', '+639171234567']);
  assert.notEqual(insert.values[4], signupDetails.password);
  const cookie = response.headers.get('set-cookie');
  for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=604800']) assert.ok(cookie.includes(attribute));
});

test('signup validation keeps the existing JSON errors and performs no database operations', async t => {
  const { calls, post } = await fixture(t);
  for (const [patch, message] of [
    [{ name: 'A' }, 'Enter your full name (2–100 characters).'],
    [{ phone: 'invalid' }, 'Enter a valid Philippine mobile number.'],
    [{ email: 'invalid' }, 'Enter a valid email address.'],
    [{ password: 'short1' }, 'Use at least 8 characters, including a number.'],
    [{ password: 'NoDigitsHere' }, 'Use at least 8 characters, including a number.'],
    [{ acceptedTerms: false }, 'Please accept the Terms and Privacy Policy.'],
  ]) {
    const response = await post('/signup', { ...signupDetails, ...patch });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: message });
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal(calls.length, 0);
});

test('existing accounts and concurrent unique-key conflicts both return the same signup conflict', async t => {
  for (const existing of [true, false]) {
    const { post } = await fixture(t, 'customer', {
      runQuery: async () => ({ rows: existing ? [{ id: 'existing-user' }] : [] }),
      transaction: async () => { throw Object.assign(new Error('unique violation'), { code: '23505' }); },
    });
    const response = await post('/signup', signupDetails);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'An account with these details already exists.' });
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('mechanic login uses the workspace role even when the body requests customer', async t => {
  const { calls, post } = await fixture(t, 'mechanic');
  const response = await post('/login', { email: ' TEST@EXAMPLE.TEST ', password: 'Password123', role: 'customer' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.role, 'mechanic');
  assert.match(response.headers.get('set-cookie'), /^fmb_session=/);
  assert.deepEqual(calls.find(call => call.sql.startsWith('SELECT * FROM users')).values, ['test@example.test']);
});

test('anonymous session lookup and logout retain their response and cookie behavior', async t => {
  const { get, post } = await fixture(t);
  const session = await get('/session');
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { user: null });
  const logout = await post('/logout', {});
  assert.equal(logout.status, 204);
  assert.equal(await logout.text(), '');
  const cookie = logout.headers.get('set-cookie');
  assert.match(cookie, /^fmb_session=;/);
  for (const attribute of ['Max-Age=0', 'HttpOnly', 'SameSite=Lax']) assert.ok(cookie.includes(attribute));
});

test('forgot-password replies stay uniform and only existing emails create a hashed reset record', async t => {
  const calls = [];
  const { post } = await fixture(t, 'customer', {
    runQuery: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: sql.startsWith('SELECT id FROM users') && values[0] === 'test@example.test' ? [{ id: 'account-1' }] : [] };
    },
  });
  for (const email of [' TEST@EXAMPLE.TEST ', 'missing@example.test', 'invalid']) {
    const response = await post('/password/forgot', { email });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const inserts = calls.filter(call => call.sql.startsWith('INSERT INTO password_resets'));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].values[0], 'account-1');
  assert.match(inserts[0].values[1], /^[a-f0-9]{64}$/);
  assert.equal(calls.some(call => call.values.includes('invalid')), false);
});

test('failed session insertion aborts the same transaction as account and mechanic creation', async t => {
  const events = [];
  const client = {
    query: async sql => {
      if (sql.startsWith('INSERT INTO users')) {
        events.push('user');
        return { rows: [{ id: 'mechanic-1', role: 'mechanic', name: 'Test User', email: 'test@example.test', phone_verified: true }] };
      }
      if (sql.startsWith('INSERT INTO mechanic_profiles')) { events.push('profile'); return { rows: [] }; }
      if (sql.startsWith('INSERT INTO auth_sessions')) { events.push('session'); throw new Error('session insert failed'); }
      throw new Error('Unexpected query outside the signup transaction.');
    },
  };
  const { post } = await fixture(t, 'mechanic', {
    transaction: async operation => {
      events.push('begin');
      try { const result = await operation(client); events.push('commit'); return result; }
      catch (error) { events.push('rollback'); throw error; }
    },
  });
  const response = await post('/signup', signupDetails);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'session insert failed' });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(events, ['begin', 'user', 'profile', 'session', 'rollback']);
});

test('unexpected database errors reach the HTTP error handler without becoming credential errors', async t => {
  const { post } = await fixture(t, 'customer', {
    runQuery: async () => { throw Object.assign(new Error('Database unavailable.'), { status: 503 }); },
  });
  const response = await post('/login', { email: 'test@example.test', password: 'Password123' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Database unavailable.' });
  assert.equal(response.headers.get('set-cookie'), null);
});

test('login retains its per-endpoint rate limit', async t => {
  const { post } = await fixture(t);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await post('/login', {});
    assert.equal(response.status, 401);
  }
  const limited = await post('/login', {});
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'Too many attempts. Please wait before trying again.' });
});
