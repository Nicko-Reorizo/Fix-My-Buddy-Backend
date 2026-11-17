import { Router } from 'express';
import { query } from '../db/pool.js';
import { haversineKm } from '../utils/validation.js';
import { availableMechanicSql, demoEmails, locationIsValid, presenceMaxAgeSeconds } from '../utils/matching.js';
import { calculateDistancePricing } from '../utils/pricing.js';

export const providerRouter = Router();

function buildVisitEstimate(profile, serviceType = 'mechanic', distanceKm = 2.4) {
  return calculateDistancePricing({
    profile,
    serviceType,
    distanceKm,
  });
}

async function formatProviderRecord(profile, { location, request } = {}) {
  const distanceKm =
    haversineKm(
      Number(location?.latitude),
      Number(location?.longitude),
      Number(profile.latitude),
      Number(profile.longitude),
    ) ?? 1.5;
  const distanceMeters = Math.max(100, Math.round(distanceKm * 1000));
  const etaMinutes = Math.max(4, Math.round(distanceKm * 4.5));
  const serviceType = request?.serviceType === 'towing' ? 'towing' : 'mechanic';
  const estimate = buildVisitEstimate(profile, serviceType, distanceKm);

  const policyRes = await query(
    `SELECT id, text FROM cancellation_policies WHERE id = $1 LIMIT 1`,
    [profile.cancellation_policy_id || 'policy-standard-v1'],
  );
  const cancellationPolicy = policyRes.rows[0] || {
    id: 'policy-standard-v1',
    text: 'Free cancellation before provider dispatch. Once the provider is en route, the call-out fee may apply.',
  };

  const reviewsRes = await query(
    `SELECT r.id, r.rating, r.body AS text, r.created_at, u.name AS author_name
     FROM booking_reviews r
     JOIN users u ON u.id = r.customer_id
     WHERE r.provider_id = $1
     ORDER BY r.created_at DESC
     LIMIT 10`,
    [profile.id],
  );

  const record = {
    id: String(profile.id),
    name: profile.display_name,
    verified: Boolean(profile.verified),
    rating: profile.rating == null ? null : Number(profile.rating),
    reviewsCount: Number(profile.reviews_count || 0),
    jobsCompleted: Number(profile.jobs_completed || 0),
    distanceKm,
    distanceMeters,
    etaMinutes,
    specialties: Array.isArray(profile.specialties) ? profile.specialties : [],
    credentials: Array.isArray(profile.credentials) ? profile.credentials : [],
    ...(profile.latitude != null && profile.longitude != null
      ? { latitude: Number(profile.latitude), longitude: Number(profile.longitude) }
      : {}),
    estimate,
    cancellationPolicy: {
      id: String(cancellationPolicy.id),
      text: cancellationPolicy.text,
    },
    customerReviews: reviewsRes.rows.map((r) => ({
      id: String(r.id),
      authorName: r.author_name || 'Customer',
      rating: Number(r.rating),
      createdAt: new Date(r.created_at).toISOString(),
      text: r.text || '',
    })),
  };

  if (serviceType === 'towing') {
    record.towingQuote = {
      routeId: `ROUTE-${profile.id}`,
      version: 1,
      distanceKm: Math.max(0.1, distanceKm),
      distanceMeters,
      pickupAddress: location?.address || 'Pickup location',
      destinationAddress: request?.destination || 'Repair shop destination',
      equipment: profile.flatbed_capability ? `Flatbed (${profile.flatbed_capability})` : 'Wheel-lift tow truck',
    };
  }

  return record;
}

// POST /providers/search
providerRouter.post('/providers/search', async (req, res, next) => {
  try {
    const { location, filters = {}, ...requestFields } = req.body || {};
    if (!locationIsValid(location)) return res.status(400).json({ error: 'Choose a valid pickup pin before finding mechanics.' });
    const radiusKm = Number(filters.radiusKm || 15);
    const minimumRating = Number(filters.minimumRating || 0);
    const verifiedOnly = Boolean(filters.verifiedOnly);
    const specialty = typeof filters.specialty === 'string' ? filters.specialty.trim() : '';
    const maximumVisitPrice =
      filters.maximumVisitPrice !== '' && filters.maximumVisitPrice != null
        ? Number(filters.maximumVisitPrice)
        : null;

    const result = await query(
      `${availableMechanicSql} ORDER BY mp.rating DESC, mp.jobs_completed DESC`,
      [demoEmails, presenceMaxAgeSeconds()],
    );

    const formatted = [];
    for (const profile of result.rows) {
      if (verifiedOnly && !profile.verified) continue;
      const wantsTowing = requestFields.serviceType === 'towing';
      const offersTowing = profile.specialties?.some(s => s.toLowerCase() === 'towing');
      if (wantsTowing && !offersTowing) continue;
      if (Number(profile.rating || 0) < minimumRating) continue;
      if (
        specialty &&
        Array.isArray(profile.specialties) &&
        !profile.specialties.some((s) => s.toLowerCase() === specialty.toLowerCase())
      ) {
        continue;
      }
      const item = await formatProviderRecord(profile, {
        location,
        request: requestFields,
      });
      if (item.distanceKm > radiusKm) continue;
      if (item.distanceKm > Number(profile.service_radius_km)) continue;
      if (maximumVisitPrice !== null && item.estimate.total > maximumVisitPrice) continue;
      formatted.push(item);
    }

    const sort = filters.sort || 'eta';
    formatted.sort((a, b) => {
      if (sort === 'price') return a.estimate.total - b.estimate.total;
      if (sort === 'rating') return (b.rating || 0) - (a.rating || 0);
      if (sort === 'distance') return a.distanceKm - b.distanceKm;
      return a.etaMinutes - b.etaMinutes;
    });

    return res.json({
      providers: formatted,
      recommendedProviderId: formatted[0]?.id || null,
    });
  } catch (error) {
    return next(error);
  }
});

// POST /providers/:id/quote
providerRouter.post('/providers/:id/quote', async (req, res, next) => {
  try {
    const providerId = String(req.params.id);
    if (!locationIsValid(req.body?.location)) return res.status(400).json({ error: 'Choose a valid pickup pin.' });
    const result = await query(
      `${availableMechanicSql} AND mp.id = $3 LIMIT 1`,
      [demoEmails, presenceMaxAgeSeconds(), providerId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found.' });
    }
    const provider = await formatProviderRecord(result.rows[0], {
      location: req.body?.location,
      request: req.body?.request,
    });
    return res.json({ provider });
  } catch (error) {
    return next(error);
  }
});

// POST /repair-shops/search
providerRouter.post('/repair-shops/search', async (req, res, next) => {
  try {
    const { location, vehicleType, radiusKm = 15 } = req.body || {};
    const result = await query(
      `SELECT * FROM repair_shops WHERE active = TRUE ORDER BY name ASC`,
    );

    const shops = [];
    for (const row of result.rows) {
      if (
        vehicleType &&
        Array.isArray(row.vehicle_types) &&
        !row.vehicle_types.includes(vehicleType)
      ) {
        continue;
      }
      const dist = haversineKm(
        Number(location?.latitude),
        Number(location?.longitude),
        Number(row.latitude),
        Number(row.longitude),
      );
      if (dist !== null && dist > Number(radiusKm || 30)) continue;
      shops.push({
        id: String(row.id),
        name: row.name,
        address: row.address,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        ...(dist !== null ? { distanceKm: dist } : { distanceKm: 2.0 }),
      });
    }

    return res.json({ shops });
  } catch (error) {
    return next(error);
  }
});
