import { WebSocketServer, WebSocket } from 'ws';
import { attachSession } from '../middleware/security.js';
import { trackingService } from '../realtime/tracking.js';
import { startTrackingBus, subscribeTracking } from '../realtime/redis.js';
import { isAllowedOrigin } from '../utils/origins.js';

async function sessionFor(req) {
  await attachSession(req, null, () => {});
  return req.user;
}
export function attachTrackingGateway(server, { service = trackingService, authenticate = sessionFor, subscribe = subscribeTracking, allowedOrigin = isAllowedOrigin } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  const send = (ws, event) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 64 * 1024) { ws.close(1013, 'Connection too slow'); return; }
    ws.send(JSON.stringify(event));
  };
  const upgrade = async (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (!['/api/ws/tracking', '/ws/tracking'].includes(url.pathname)) return;
    const onError = () => {};
    socket.on('error', onError);
    const timeout = setTimeout(() => socket.destroy(), 10000);
    try {
      // Browsers send Origin; enforce it separately from HTTP CORS for cookies.
      if (!req.headers.origin || !allowedOrigin(req.headers.origin, req)) throw Object.assign(new Error(), { status: 403 });
      const user = await authenticate(req);
      const bookingId = url.searchParams.get('bookingId');
      const snapshot = await service.snapshot(user, bookingId);
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, ws => {
        ws.context = { req, bookingId };
        ws.alive = true;
        ws.on('error', () => {});
        ws.on('pong', () => { ws.alive = true; });
        let pending = false, lastUpdate = 0;
        ws.on('message', async (raw, binary) => {
          if (pending) return;
          pending = true;
          try {
            const message = !binary && JSON.parse(raw.toString());
            if (message?.type !== 'location:update') throw Object.assign(new Error('Unknown tracking message.'), { status: 400 });
            if (Date.now() - lastUpdate < 2000) return;
            lastUpdate = Date.now();
            const currentUser = await authenticate(req);
            const event = await service.update(currentUser, bookingId, message.position);
            send(ws, { type: 'location:saved', bookingId, updatedAt: event.position.updatedAt });
          } catch (error) {
            send(ws, { type: 'tracking:error', status: error.status || 400, message: error.status ? error.message : 'Could not save GPS update.' });
            if ([401, 403, 409].includes(error.status)) ws.close(1008, 'Tracking access ended');
          } finally { pending = false; }
        });
        send(ws, snapshot);
      });
    } catch (error) {
      if (!socket.destroyed) { socket.write(`HTTP/1.1 ${[400,401,403,409].includes(error.status) ? error.status : 503} Rejected\r\nConnection: close\r\n\r\n`); socket.destroy(); }
    } finally { clearTimeout(timeout); socket.off('error', onError); }
  };
  server.on('upgrade', upgrade);
  // Recheck the live session and booking ownership before each delivery. Logout,
  // reassignment and completed/cancelled jobs cannot retain access to a room.
  async function check(ws, event) {
    if (ws.checking || ws.readyState !== WebSocket.OPEN) return;
    ws.checking = true;
    try {
      const { req, bookingId } = ws.context;
      await service.snapshot(await authenticate(req), bookingId);
      if (event) send(ws, event);
    } catch { ws.close(1008, 'Tracking access ended'); }
    finally { ws.checking = false; }
  }
  const unsubscribe = subscribe(event => {
    for (const ws of wss.clients) if (ws.context.bookingId === event.bookingId) void check(ws, event);
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping(); void check(ws);
    }
    void startTrackingBus();
  }, 15000);
  heartbeat.unref();
  void startTrackingBus();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat); unsubscribe(); server.off('upgrade', upgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
  server.once('close', close);
  return close;
}
