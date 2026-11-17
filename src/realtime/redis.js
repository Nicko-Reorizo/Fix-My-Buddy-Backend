import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// One local bus per process. Redis is optional for a single server; all instances
// must share REDIS_URL when horizontal scaling is enabled.
const events = new EventEmitter();
events.setMaxListeners(0);
const source = randomUUID();
const channel = 'fixmybuddy:tracking:v1';
let publisher;
let subscriber;
let starting;
let retryAfter = 0;

export function subscribeTracking(listener) {
  events.on('location', listener);
  return () => events.off('location', listener);
}

export async function startTrackingBus() {
  if (!process.env.REDIS_URL || starting || publisher || Date.now() < retryAfter) return starting;
  starting = (async () => {
    const { createClient } = await import('redis');
    publisher = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true, socket: { connectTimeout: 3000, reconnectStrategy: retries => Math.min(500 * (retries + 1), 10000) } });
    subscriber = publisher.duplicate();
    for (const client of [publisher, subscriber]) client.on('error', () => {});
    // Initial failures must not block the local development server indefinitely.
    const deadline = setTimeout(() => {
      if (!publisher?.isReady || !subscriber?.isReady) { publisher?.destroy(); subscriber?.destroy(); }
    }, 4000);
    try {
      await Promise.all([publisher.connect(), subscriber.connect()]);
      await subscriber.subscribe(channel, raw => {
        try {
          const message = JSON.parse(raw);
          if (message.source !== source && message.event?.type === 'location:updated') events.emit('location', message.event);
        } catch { /* Ignore malformed bus data. */ }
      });
    } catch {
      publisher?.destroy(); subscriber?.destroy(); publisher = null; subscriber = null;
      retryAfter = Date.now() + 10000;
      console.warn('[Tracking] Redis unavailable; using local delivery. Other instances may miss updates.');
    } finally { clearTimeout(deadline); starting = null; }
  })();
  return starting;
}

export async function publishTracking(event) {
  events.emit('location', event);
  if (!publisher?.isReady) { void startTrackingBus(); return; }
  try { await publisher.publish(channel, JSON.stringify({ source, event })); }
  catch { console.warn('[Tracking] Redis publish failed; location remains saved in PostgreSQL.'); }
}

export async function stopTrackingBus() {
  publisher?.destroy(); subscriber?.destroy(); publisher = null; subscriber = null;
}
