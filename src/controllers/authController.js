import { clearSession, createSession } from '../middleware/security.js';
import { isEmail, normalizePhone } from '../utils/validation.js';
import { AuthError, createAuthService } from '../services/authService.js';

const authErrorStatuses = { ACCOUNT_EXISTS: 409, INVALID_CREDENTIALS: 401, WRONG_ROLE: 403 };

function respondToError(error, res, next) {
  if (error instanceof AuthError && authErrorStatuses[error.code]) {
    return res.status(authErrorStatuses[error.code]).json({ error: error.message });
  }
  return next(error);
}

// Controllers validate HTTP input and keep response/cookie handling out of the service.
export function createAuthController({ role, runQuery, transaction, session = createSession } = {}) {
  const service = createAuthService({ role, runQuery, transaction });

  function getSession(req, res) {
    return res.json({ user: req.user || null });
  }

  async function logout(req, res, next) {
    try {
      await clearSession(req, res);
      return res.status(204).end();
    } catch (error) { return next(error); }
  }

  async function signup(req, res, next) {
    try {
      const { name, phone, email, password, acceptedTerms, role = 'customer' } = req.body || {};
      const cleanName = typeof name === 'string' ? name.trim() : '';
      const cleanPhone = normalizePhone(phone);
      const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (cleanName.length < 2 || cleanName.length > 100) return res.status(400).json({ error: 'Enter your full name (2–100 characters).' });
      if (!cleanPhone) return res.status(400).json({ error: 'Enter a valid Philippine mobile number.' });
      if (!isEmail(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (typeof password !== 'string' || password.length < 8 || !/[0-9]/.test(password)) return res.status(400).json({ error: 'Use at least 8 characters, including a number.' });
      if (acceptedTerms !== true) return res.status(400).json({ error: 'Please accept the Terms and Privacy Policy.' });

      const user = await service.signup(
        { name: cleanName, phone: cleanPhone, email: cleanEmail, password, role },
        (nextUser, execute) => session(res, req, nextUser, execute),
      );
      return res.status(201).json({ user });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An account with these details already exists.' });
      return respondToError(error, res, next);
    }
  }

  async function login(req, res, next) {
    try {
      const { email, password, role = 'customer' } = req.body || {};
      const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!isEmail(cleanEmail) || typeof password !== 'string' || !password) return res.status(401).json({ error: 'Invalid credentials.' });
      const user = await service.login({ email: cleanEmail, password, role });
      await session(res, req, user);
      return res.json({ user });
    } catch (error) { return respondToError(error, res, next); }
  }

  function retiredPhone(_req, res) {
    return res.status(410).json({ error: 'Phone-code sign-in has been retired. Use your email and password.' });
  }

  async function forgotPassword(req, res, next) {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      if (isEmail(email)) await service.forgotPassword(email);
      return res.json({ ok: true });
    } catch (error) { return next(error); }
  }

  return { getSession, logout, signup, login, retiredPhone, forgotPassword };
}
