import process from 'node:process';

export function locationIsValid(location) {
  return typeof location?.latitude === 'number' && Number.isFinite(location.latitude)
    && Math.abs(location.latitude) <= 90 && typeof location?.longitude === 'number'
    && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180;
}

export function presenceMaxAgeSeconds() {
  const value = Number(process.env.MECHANIC_PRESENCE_MAX_AGE_S || 120);
  return Number.isFinite(value) && value >= 30 ? value : 120;
}

// These shipped accounts are examples, never customers' real matching candidates.
export const demoEmails = ['miguel.santos@example.com', 'alex.reyes@example.com'];

export const availableMechanicSql = `
  SELECT mp.*,
    (SELECT avg(r.rating) FROM booking_reviews r WHERE r.provider_id=mp.id) AS rating,
    (SELECT count(*) FROM booking_reviews r WHERE r.provider_id=mp.id) AS reviews_count,
    (SELECT count(*) FROM bookings completed WHERE completed.provider_id=mp.id AND completed.status='completed') AS jobs_completed
  FROM mechanic_profiles mp JOIN users u ON u.id = mp.user_id
  WHERE u.role = 'mechanic' AND u.phone_verified = TRUE
    AND NOT (lower(u.email) = ANY($1::text[]))
    AND mp.online = TRUE AND mp.latitude IS NOT NULL AND mp.longitude IS NOT NULL
    AND mp.position_updated_at > NOW() - ($2::int * interval '1 second')
    AND EXISTS (SELECT 1 FROM auth_sessions s WHERE s.user_id = u.id
      AND s.revoked_at IS NULL AND s.expires_at > NOW())
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.provider_id = mp.id
      AND b.status IN ('accepted', 'en_route', 'arrived', 'in_progress'))
`;
