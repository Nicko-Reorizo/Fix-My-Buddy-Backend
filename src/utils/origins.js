import process from 'node:process';

function parseOrigin(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[^/\\?#\s]+\/?$/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

export function isAllowedOrigin(origin, req) {
  if (!origin) return true;
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  const configured = (process.env.FRONTEND_ORIGIN || '').split(',').map(value => parseOrigin(value.trim())?.origin);
  if (configured.includes(parsed.origin)) return true;

  const production = process.env.NODE_ENV === 'production';
  // Browser Host identifies the actual request destination. Forwarded host/proto
  // headers may be supplied by clients and must not expand the origin allowlist.
  const host = req?.headers?.host;
  if (typeof host === 'string') {
    const ownOrigin = parseOrigin(`${production || req.socket?.encrypted ? 'https' : 'http'}://${host}`);
    if (ownOrigin?.origin === parsed.origin) return true;
  }
  // Vercel's deployment hostnames are trusted environment values, including when
  // a serverless adapter presents an internal Host header to Express.
  if (process.env.VERCEL === '1') {
    for (const key of ['VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_BRANCH_URL']) {
      const deploymentOrigin = parseOrigin(`https://${process.env[key] || ''}`);
      if (deploymentOrigin?.origin === parsed.origin) return true;
    }
  }
  return !production && /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(parsed.origin);
}
