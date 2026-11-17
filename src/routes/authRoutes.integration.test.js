import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import process from 'node:process';
import express from 'express';
import pg from 'pg';
import { getConnectionConfig } from '../db/pool.js';
import { createSession, createSessionMiddleware } from '../middleware/security.js';
import { hashToken, verifyPassword } from '../utils/crypto.js';
import { createAuthRouter } from './authRoutes.js';

// Explicitly opt in against a migrated database. Every write uses this one
// connection and transaction; cleanup always rolls it back, including failures.
test('real database signup and login create authenticated customer and mechanic sessions', {
  skip: process.env.RUN_DATABASE_TESTS !== '1',
  timeout: 90000,
}, async () => {
  const config = getConnectionConfig();
  assert.ok(config, 'Configure a migrated database before running the opt-in auth regression.');
  const client = new pg.Client({
    ...config,
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 60000,
    application_name: 'fixmybuddy-auth-regression',
  });
  let server;
  let connected = false;
  const emails = [];
  try {
    await client.connect();
    connected = true;
    await client.query('BEGIN');
    const runQuery = client.query.bind(client);
    // The router's signup transaction and login session both use the outer
    // transaction. No pool, nested COMMIT, or deployed endpoint receives writes.
    const dependencies = {
      runQuery,
      transaction: operation => operation(client),
      session: (res, req, user, query = runQuery) => createSession(res, req, user, query),
    };
    const app = express();
    app.use(express.json());
    app.use(createSessionMiddleware({ runQuery }));
    app.use('/api/auth', createAuthRouter(dependencies));
    app.use('/api/mechanics/auth', createAuthRouter({ ...dependencies, role: 'mechanic' }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: 'Integration request failed.' }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    async function request(path, { method = 'GET', body, cookie } = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json(), setCookie: response.headers.get('set-cookie') };
    }
    for (const role of ['customer', 'mechanic']) {
      const email = `auth-${role}-${randomUUID()}@integration.invalid`;
      emails.push(email);
      // Avoid even an unlikely collision with an existing customer's number.
      let phone;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        phone = `+639${String(randomInt(1000000000)).padStart(9, '0')}`;
        if (!(await runQuery('SELECT 1 FROM users WHERE phone = $1', [phone])).rows.length) break;
        phone = undefined;
      }
      assert.ok(phone, 'Could not select an unused integration fixture number.');
      const details = { name: `Integration ${role}`, email, phone, password: `Integration9-${randomUUID()}`, role, acceptedTerms: true };
      const path = role === 'mechanic' ? '/api/mechanics/auth' : '/api/auth';
      const signup = await request(`${path}/signup`, { method: 'POST', body: details });
      assert.equal(signup.status, 201, `${role} signup should create an account and session.`);
      assert.equal(signup.data.user.role, role);
      assert.equal(signup.data.user.phoneVerified, true);
      assert.equal(signup.data.challenge, undefined);
      assert.match(signup.setCookie || '', /^fmb_session=[^;]+;/);
      assert.match(signup.setCookie, /HttpOnly/);
      const cookie = signup.setCookie.split(';', 1)[0];
      const session = await request(`${path}/session`, { cookie });
      assert.equal(session.status, 200);
      assert.equal(session.data.user.id, signup.data.user.id, `${role} signup cookie must authenticate.`);
      assert.equal(session.data.user.role, role);

      const stored = (await runQuery('SELECT password_hash, accepted_terms FROM users WHERE id = $1', [signup.data.user.id])).rows[0];
      assert.equal(stored.accepted_terms, true);
      assert.equal(await verifyPassword(details.password, stored.password_hash), true);
      assert.notEqual(stored.password_hash, details.password);
      const storedSession = (await runQuery('SELECT token_hash FROM auth_sessions WHERE user_id = $1', [signup.data.user.id])).rows;
      assert.equal(storedSession.length, 1);
      assert.equal(storedSession[0].token_hash, hashToken(decodeURIComponent(cookie.slice('fmb_session='.length))));
      const profiles = (await runQuery('SELECT user_id, verified, online FROM mechanic_profiles WHERE user_id = $1', [signup.data.user.id])).rows;
      assert.equal(profiles.length, role === 'mechanic' ? 1 : 0);
      if (role === 'mechanic') {
        assert.equal(profiles[0].user_id, signup.data.user.id);
        assert.equal(profiles[0].verified, false);
        assert.equal(profiles[0].online, false);
      }

      const duplicate = await request(`${path}/signup`, { method: 'POST', body: details });
      assert.equal(duplicate.status, 409, `${role} duplicate signup should be a validation conflict.`);
      assert.equal(duplicate.setCookie, null);
      const login = await request(`${path}/login`, { method: 'POST', body: { email, password: details.password, role } });
      assert.equal(login.status, 200, `${role} can sign in with the newly hashed password.`);
      assert.equal(login.data.user.id, signup.data.user.id);
      assert.match(login.setCookie || '', /^fmb_session=[^;]+;/);
      const loggedIn = await request(`${path}/session`, { cookie: login.setCookie.split(';', 1)[0] });
      assert.equal(loggedIn.data.user.id, signup.data.user.id);
      assert.equal((await runQuery('SELECT COUNT(*)::int AS count FROM auth_sessions WHERE user_id = $1', [signup.data.user.id])).rows[0].count, 2);
    }
  } finally {
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      try {
        if (connected) {
          await client.query('ROLLBACK');
          if (emails.length) {
            const remaining = await client.query('SELECT COUNT(*)::int AS count FROM users WHERE email = ANY($1::text[])', [emails]);
            assert.equal(remaining.rows[0].count, 0, 'The integration regression must leave no accounts behind.');
          }
        }
      } finally {
        await client.end();
      }
    }
  }
});
