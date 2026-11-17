import { query, withTransaction } from '../db/pool.js';
import { haversineKm } from '../utils/validation.js';
import { publishTracking } from './redis.js';

export const trackingStatuses = ['en_route', 'accepted', 'in_progress'];
export function trackingError(status, message) { return Object.assign(new Error(message), { status }); }
export function validCoordinates(value) {
  return Boolean(value && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180);
}
const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export function createTrackingService({ runQuery = query, transaction = withTransaction, publish = publishTracking } = {}) {
  async function booking(user, id, exec = runQuery, lock = false) {
    if (!user) throw trackingError(401, 'Please sign in again.');
    if (!validId(id)) throw trackingError(400, 'Invalid booking ID.');
    const result = await exec(
      `SELECT b.*, p.user_id AS provider_user_id, p.latitude, p.longitude, p.position_updated_at, p.location_source
       FROM bookings b JOIN mechanic_profiles p ON p.id = b.provider_id WHERE b.id = $1${lock ? ' FOR UPDATE OF b' : ''}`, [id],
    );
    const row = result.rows[0];
    const customer = user.role === 'customer' && String(row?.customer_id) === String(user.id);
    const mechanic = user.role === 'mechanic' && String(row?.provider_user_id) === String(user.id);
    if (!row || (!customer && !mechanic)) throw trackingError(403, 'This booking is not available to your account.');
    if (!trackingStatuses.includes(row.status)) throw trackingError(409, 'Location sharing is inactive for this booking.');
    return row;
  }
  function eventFor(row, position) {
    const distanceMeters = validCoordinates({ latitude: Number(row.pickup_lat), longitude: Number(row.pickup_lng) }) && row.pickup_lat != null && row.pickup_lng != null
      ? Math.round(haversineKm(position.latitude, position.longitude, Number(row.pickup_lat), Number(row.pickup_lng)) * 1000) : null;
    return { type: 'location:updated', bookingId: String(row.id), position, distanceMeters };
  }
  return {
    async snapshot(user, id) {
      const row = await booking(user, id);
      const position = row.location_source !== 'manual' && row.latitude != null && row.longitude != null && row.position_updated_at
        ? { latitude: Number(row.latitude), longitude: Number(row.longitude), updatedAt: new Date(row.position_updated_at).toISOString() } : null;
      return position ? eventFor(row, position) : { type: 'tracking:ready', bookingId: id };
    },
    async update(user, id, position) {
      if (user?.role !== 'mechanic') throw trackingError(403, 'Only the assigned mechanic can share GPS.');
      if (!validCoordinates(position)) throw trackingError(400, 'Valid numeric GPS coordinates are required.');
      const event = await transaction(async client => {
        const exec = client.query.bind(client);
        const row = await booking(user, id, exec, true);
        const saved = await exec(
          `UPDATE mechanic_profiles SET latitude=$1, longitude=$2, location_source='gps', position_updated_at=NOW(), updated_at=NOW() WHERE id=$3 RETURNING position_updated_at`,
          [position.latitude, position.longitude, row.provider_id],
        );
        return eventFor(row, { latitude: position.latitude, longitude: position.longitude, updatedAt: new Date(saved.rows[0].position_updated_at).toISOString() });
      });
      await publish(event);
      return event;
    },
  };
}
export const trackingService = createTrackingService();
