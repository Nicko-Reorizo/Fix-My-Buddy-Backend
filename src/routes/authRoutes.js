import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { generateOpaqueToken, hashPassword, hashToken, verifyPassword } from '../utils/crypto.js';
import { isEmail, normalizePhone } from '../utils/validation.js';
import { clearSession, createRateLimiter, createSession, formatUser } from '../middleware/security.js';

// Inject database/session operations so HTTP regressions can run without PostgreSQL.
export function createAuthRouter({ role: requiredRole, runQuery = query, transaction = withTransaction, session = createSession } = {}) {
  const router = Router();
  const limiter = createRateLimiter({ windowMs: 60_000, max: 15 });
  router.get('/session', (req, res) => res.json({ user: req.user || null }));
  router.post('/logout', async (req, res, next) => {
    try { await clearSession(req, res); res.status(204).end(); } catch (error) { next(error); }
  });
  router.post('/signup', limiter, async (req, res, next) => {
    try {
      const { name, phone, email, password, acceptedTerms, role = 'customer' } = req.body || {};
      const cleanName = typeof name === 'string' ? name.trim() : '';
      const cleanPhone = normalizePhone(phone);
      const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      const accountRole = requiredRole || (role === 'mechanic' ? 'mechanic' : 'customer');
      if (cleanName.length < 2 || cleanName.length > 100) return res.status(400).json({ error: 'Enter your full name (2–100 characters).' });
      if (!cleanPhone) return res.status(400).json({ error: 'Enter a valid Philippine mobile number.' });
      if (!isEmail(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (typeof password !== 'string' || password.length < 8 || !/[0-9]/.test(password)) return res.status(400).json({ error: 'Use at least 8 characters, including a number.' });
      if (acceptedTerms !== true) return res.status(400).json({ error: 'Please accept the Terms and Privacy Policy.' });
      const existing = await runQuery('SELECT id FROM users WHERE lower(email) = $1 OR phone = $2 LIMIT 1', [cleanEmail, cleanPhone]);
      if (existing.rows.length) return res.status(409).json({ error: 'An account with these details already exists.' });
      const passwordHash = await hashPassword(password);
      const user = await transaction(async (client) => {
        // Legacy eligibility flag auto-set by policy, not proof of SMS ownership.
        const created = await client.query(
          'INSERT INTO users (role, name, email, phone, phone_verified, password_hash, accepted_terms, accepted_terms_at) VALUES ($1, $2, $3, $4, TRUE, $5, TRUE, NOW()) RETURNING *',
          [accountRole, cleanName, cleanEmail, cleanPhone, passwordHash],
        );
        const row = created.rows[0];
        if (accountRole === 'mechanic') await client.query(
          'INSERT INTO mechanic_profiles (id, user_id, display_name, verified, online) VALUES ($1, $2, $3, FALSE, FALSE)',
          ['PRO-' + randomUUID(), row.id, row.name],
        );
        const nextUser = formatUser(row);
        await session(res, req, nextUser, client.query.bind(client));
        return nextUser;
      });
      return res.status(201).json({ user });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An account with these details already exists.' });
      return next(error);
    }
  });
  router.post('/login', limiter, async (req, res, next) => {
    try {
      const { email, password, role = 'customer' } = req.body || {};
      const accountRole = requiredRole || role;
      const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!isEmail(cleanEmail) || typeof password !== 'string' || !password) return res.status(401).json({ error: 'Invalid credentials.' });
      const result = await runQuery('SELECT * FROM users WHERE lower(email) = $1 LIMIT 1', [cleanEmail]);
      const row = result.rows[0];
      if (!row || !await verifyPassword(password, row.password_hash)) return res.status(401).json({ error: 'Invalid credentials.' });
      if (row.role !== accountRole) return res.status(403).json({ error: 'Please sign in using your ' + row.role + ' account page.' });
      if (!row.phone_verified) {
        await runQuery('UPDATE users SET phone_verified = TRUE, updated_at = NOW() WHERE id = $1', [row.id]);
        row.phone_verified = true;
      }
      const user = formatUser(row);
      await session(res, req, user);
      return res.json({ user });
    } catch (error) { return next(error); }
  });
  // Retire old challenges, without allowing unauthenticated phone-only access.
  for (const path of ['/phone/start', '/phone/verify', '/phone/resend']) router.post(path, (_req, res) => res.status(410).json({ error: 'Phone-code sign-in has been retired. Use your email and password.' }));
  router.post('/password/forgot', limiter, async (req, res, next) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      if (isEmail(email)) {
        const result = await runQuery('SELECT id FROM users WHERE lower(email) = $1 LIMIT 1', [email]);
        if (result.rows.length) await runQuery(
          "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes')",
          [result.rows[0].id, hashToken(generateOpaqueToken(24))],
        );
      }
      return res.json({ ok: true });
    } catch (error) { return next(error); }
  });
  return router;
}
export const authRouter = createAuthRouter();
export const mechanicAuthRouter = createAuthRouter({ role: 'mechanic' });
