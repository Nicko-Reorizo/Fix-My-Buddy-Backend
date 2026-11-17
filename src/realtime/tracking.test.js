import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createTrackingService } from './tracking.js';
import { attachTrackingGateway } from '../ws/gateway.js';

const id = '00000000-0000-4000-8000-000000000001';
const mechanic = { id: 'mechanic', role: 'mechanic' }, customer = { id: 'customer', role: 'customer' };
test('tracking restricts ownership, validates coordinates, saves before broadcast and stops on completion', async () => {
  let status = 'en_route', committed = false, sent;
  const query = async sql => sql.startsWith('SELECT') ? { rows: [{ id, provider_id: 'pro', customer_id: 'customer', provider_user_id: 'mechanic', status, pickup_lat: 14.6, pickup_lng: 121 }] } : { rows: [{ position_updated_at: new Date() }] };
  const service = createTrackingService({ runQuery: query, transaction: async fn => { const result = await fn({ query }); committed = true; return result; }, publish: event => { assert.equal(committed, true); sent = event; } });
  await assert.rejects(service.update(customer, id, { latitude: 14, longitude: 121 }), error => error.status === 403);
  await assert.rejects(service.snapshot({ ...customer, id: 'stranger' }, id), error => error.status === 403);
  for (const latitude of [null, '', '14', 91, NaN]) await assert.rejects(service.update(mechanic, id, { latitude, longitude: 121 }), error => error.status === 400);
  await service.update(mechanic, id, { latitude: 14.59, longitude: 121 });
  assert.equal(sent.bookingId, id); assert.equal(sent.position.latitude, 14.59);
  status = 'completed';
  await assert.rejects(service.snapshot(customer, id), error => error.status === 409);
  await assert.rejects(service.update(mechanic, id, { latitude: 14, longitude: 121 }), error => error.status === 409);
});

test('real WebSocket receives assigned mechanic GPS and closes a revoked customer session', { timeout: 10000 }, async t => {
  let publish, revoked = false;
  const query = async sql => sql.startsWith('SELECT') ? { rows: [{ id, provider_id: 'pro', customer_id: customer.id, provider_user_id: mechanic.id, status: 'en_route' }] } : { rows: [{ position_updated_at: new Date() }] };
  const service = createTrackingService({ runQuery: query, transaction: fn => fn({ query }), publish: event => publish(event) });
  const server = createServer();
  const detach = attachTrackingGateway(server, { service, subscribe: listener => { publish = listener; return () => {}; }, authenticate: async req => req.headers.cookie === 'mechanic' ? mechanic : revoked ? null : customer });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const options = cookie => ({ origin: 'http://localhost:5173', headers: { cookie } });
  const url = `ws://127.0.0.1:${server.address().port}/api/ws/tracking?bookingId=${id}`;
  const reader = new WebSocket(url, options('customer')), writer = new WebSocket(url, options('mechanic'));
  t.after(async () => { reader.terminate(); writer.terminate(); detach(); await new Promise(resolve => server.close(resolve)); });
  const readyReader = once(reader, 'message'), readyWriter = once(writer, 'message');
  await Promise.all([readyReader, readyWriter]);
  const delivered = once(reader, 'message');
  writer.send(JSON.stringify({ type: 'location:update', position: { latitude: 14.61, longitude: 121 } }));
  const [raw] = await delivered;
  assert.equal(JSON.parse(raw).position.latitude, 14.61);
  revoked = true;
  const closed = once(reader, 'close');
  publish({ type: 'location:updated', bookingId: id, position: { latitude: 14.62, longitude: 121, updatedAt: new Date().toISOString() } });
  const [code] = await closed;
  assert.equal(code, 1008);
});
