import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { generateOpaqueToken, hashPassword, hashToken, verifyPassword } from '../utils/crypto.js';
import { formatUser } from '../middleware/security.js';

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

// Account operations use injectable database functions without depending on HTTP.
export function createAuthService({ role: requiredRole, runQuery = query, transaction = withTransaction } = {}) {
  async function signup({ name, phone, email, password, role }, establishSession) {
    const accountRole = requiredRole || (role === 'mechanic' ? 'mechanic' : 'customer');
    const existing = await runQuery('SELECT id FROM users WHERE lower(email) = $1 OR phone = $2 LIMIT 1', [email, phone]);
    if (existing.rows.length) throw new AuthError('ACCOUNT_EXISTS', 'An account with these details already exists.');

    const passwordHash = await hashPassword(password);
    return transaction(async client => {
      // Legacy eligibility flag auto-set by policy, not proof of SMS ownership.
      const created = await client.query(
        'INSERT INTO users (role, name, email, phone, phone_verified, password_hash, accepted_terms, accepted_terms_at) VALUES ($1, $2, $3, $4, TRUE, $5, TRUE, NOW()) RETURNING *',
        [accountRole, name, email, phone, passwordHash],
      );
      const row = created.rows[0];
      if (accountRole === 'mechanic') await client.query(
        'INSERT INTO mechanic_profiles (id, user_id, display_name, verified, online) VALUES ($1, $2, $3, FALSE, FALSE)',
        ['PRO-' + randomUUID(), row.id, row.name],
      );
      const user = formatUser(row);
      // The controller supplies cookie handling; session writes must finish
      // on this same connection before the account transaction commits.
      await establishSession(user, client.query.bind(client));
      return user;
    });
  }

  async function login({ email, password, role }) {
    const accountRole = requiredRole || role;
    const result = await runQuery('SELECT * FROM users WHERE lower(email) = $1 LIMIT 1', [email]);
    const row = result.rows[0];
    if (!row || !await verifyPassword(password, row.password_hash)) {
      throw new AuthError('INVALID_CREDENTIALS', 'Invalid credentials.');
    }
    if (row.role !== accountRole) {
      throw new AuthError('WRONG_ROLE', 'Please sign in using your ' + row.role + ' account page.');
    }
    if (!row.phone_verified) {
      await runQuery('UPDATE users SET phone_verified = TRUE, updated_at = NOW() WHERE id = $1', [row.id]);
      row.phone_verified = true;
    }
    return formatUser(row);
  }

  async function forgotPassword(email) {
    const result = await runQuery('SELECT id FROM users WHERE lower(email) = $1 LIMIT 1', [email]);
    if (result.rows.length) await runQuery(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes')",
      [result.rows[0].id, hashToken(generateOpaqueToken(24))],
    );
  }

  return { signup, login, forgotPassword };
}
