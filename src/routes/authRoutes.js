import { Router } from 'express';
import { createAuthController } from '../controllers/authController.js';
import { createRateLimiter } from '../middleware/security.js';

// Routes define URLs and middleware; controllers and services handle auth operations.
export function createAuthRouter(options = {}) {
  const router = Router();
  const controller = createAuthController(options);
  const limiter = createRateLimiter({ windowMs: 60_000, max: 15 });

  router.get('/session', controller.getSession);
  router.post('/logout', controller.logout);
  router.post('/signup', limiter, controller.signup);
  router.post('/login', limiter, controller.login);
  for (const path of ['/phone/start', '/phone/verify', '/phone/resend']) {
    router.post(path, controller.retiredPhone);
  }
  router.post('/password/forgot', limiter, controller.forgotPassword);
  return router;
}

export const authRouter = createAuthRouter();
export const mechanicAuthRouter = createAuthRouter({ role: 'mechanic' });
