import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import process from 'node:process';
import { Router } from 'express';
import { registerBookingMessages } from './bookingMessages.js';
import { query, withTransaction } from '../db/pool.js';
import { formatUser, requireAuth } from '../middleware/security.js';
import { generateNumericCode, hashToken, verifyTokenHash } from '../utils/crypto.js';
import { cleanPlate, normalizePhone, normalizedPlateKey, haversineKm } from '../utils/validation.js';
import { availableMechanicSql, demoEmails, locationIsValid, presenceMaxAgeSeconds } from '../utils/matching.js';
import { calculateCommissionBreakdown, calculateDistancePricing } from '../utils/pricing.js';
import { buildEmvcoQrPhPayload, createPaymentCheckoutSession } from '../utils/paymentGateway.js';

export const customerRouter = Router();

function formatVehicleRow(row) {
  return {
    id: String(row.id),
    type: row.type,
    make: row.make,
    model: row.model,
    year: Number(row.year),
    color: row.color,
    plate: row.plate || '',
  };
}

export async function formatBookingRow(row) {
  let providerProfile = null;
  if (row.provider_id) {
    const provRes = await query(
      `SELECT p.*, u.phone AS provider_phone
       FROM mechanic_profiles p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id = $1 LIMIT 1`,
      [row.provider_id],
    );
    providerProfile = provRes.rows[0] || null;
  }

  let policy = null;
  if (row.cancellation_policy_id) {
    const polRes = await query(
      `SELECT id, text FROM cancellation_policies WHERE id = $1 LIMIT 1`,
      [row.cancellation_policy_id],
    );
    policy = polRes.rows[0] || null;
  }

  const reviewRes = await query(
    `SELECT * FROM booking_reviews WHERE booking_id = $1 LIMIT 1`,
    [row.id],
  );
  const reviewRow = reviewRes.rows[0] || null;

  const preDispatch =
    ['requested', 'pending', 'confirmed', 'accepted', 'scheduled'].includes(row.status) &&
    !row.dispatched_at;

  const hasPickupCoords =
    row.pickup_lat != null &&
    row.pickup_lng != null &&
    Number.isFinite(Number(row.pickup_lat)) &&
    Number.isFinite(Number(row.pickup_lng));

  const hasProviderCoords =
    providerProfile?.latitude != null &&
    providerProfile?.longitude != null &&
    Number.isFinite(Number(providerProfile.latitude)) &&
    Number.isFinite(Number(providerProfile.longitude));

  const liveDistanceKm =
    hasPickupCoords && hasProviderCoords
      ? haversineKm(
          Number(row.pickup_lat),
          Number(row.pickup_lng),
          Number(providerProfile.latitude),
          Number(providerProfile.longitude),
        )
      : null;

  const liveDistanceMeters =
    liveDistanceKm != null ? Math.max(0, Math.round(liveDistanceKm * 1000)) : null;

  const liveEtaMinutes =
    liveDistanceKm != null ? Math.max(1, Math.round(liveDistanceKm * 4)) : null;

  const providerSummary = providerProfile
    ? {
        id: String(providerProfile.id),
        name: providerProfile.display_name,
        verified: Boolean(providerProfile.verified),
        rating: Number(providerProfile.reviews_count) > 0 ? Number(providerProfile.rating) : null,
        reviewsCount: Number(providerProfile.reviews_count || 0),
        chatEnabled: true,
        ...(providerProfile.provider_phone ? { phone: providerProfile.provider_phone } : {}),
        ...(hasProviderCoords
          ? {
              position: {
                latitude: Number(providerProfile.latitude),
                longitude: Number(providerProfile.longitude),
                updatedAt: providerProfile.position_updated_at
                  ? new Date(providerProfile.position_updated_at).toISOString()
                  : new Date().toISOString(),
              },
            }
          : {}),
      }
    : null;

  const mechanicState =
    row.service_type === 'mechanic'
      ? {
          status: row.mechanic_state?.status || row.status,
          updatedAt: row.mechanic_state?.updatedAt || new Date(row.updated_at).toISOString(),
          ...(providerSummary ? { provider: providerSummary } : {}),
          etaMinutes:
            row.mechanic_state?.etaMinutes != null
              ? Number(row.mechanic_state.etaMinutes)
              : liveEtaMinutes ?? 10,
          ...(liveDistanceMeters != null ? { distanceMeters: liveDistanceMeters } : {}),
          ...(liveDistanceKm != null ? { distanceKm: liveDistanceKm } : {}),
          ...(providerSummary?.position ? { position: providerSummary.position } : {}),
          arrivalPinAvailable:
            !row.arrival_verified_at &&
            Boolean(row.arrival_pin_plain) &&
            !['completed', 'cancelled', 'rejected'].includes(row.status),
          workPaused: Boolean(row.mechanic_state?.workPaused),
          ...(row.mechanic_state?.estimatedFinishAt
            ? { estimatedFinishAt: row.mechanic_state.estimatedFinishAt }
            : {}),
          ...(row.mechanic_state?.diagnosis ? { diagnosis: row.mechanic_state.diagnosis } : {}),
          timeline: Array.isArray(row.mechanic_state?.timeline)
            ? row.mechanic_state.timeline
            : [
                {
                  id: 'confirmed',
                  label: 'Booking confirmed',
                  status: 'completed',
                  at: new Date(row.created_at).toISOString(),
                },
                {
                  id: 'service',
                  label: 'Roadside service in progress',
                  status: row.status === 'completed' ? 'completed' : 'current',
                },
              ],
          updates: Array.isArray(row.mechanic_state?.updates)
            ? row.mechanic_state.updates
            : [],
        }
      : undefined;

  const towingState =
    row.service_type === 'towing'
      ? {
          status: row.towing_state?.status || row.status || 'en_route',
          destinationAddress: row.destination_address || 'Destination repair shop',
          distanceKm: liveDistanceKm ?? row.towing_route?.distanceKm ?? 5,
          ...(liveDistanceMeters != null ? { distanceMeters: liveDistanceMeters } : {}),
          etaMinutes: row.towing_state?.etaMinutes ?? liveEtaMinutes ?? 15,
          equipment: row.towing_route?.equipment || 'Flatbed tow truck',
          provider: providerSummary || {
            name: 'Assigned Towing Provider',
            chatEnabled: true,
          },
          canConfirmHandover:
            row.towing_state?.status === 'at_destination' &&
            row.towing_state?.handover?.status !== 'confirmed',
          handover: row.towing_state?.handover || {
            requiresPin: true,
          },
        }
      : undefined;

  const grossAmount = Number(row.paid_amount ?? row.quoted_amount ?? 0);
  const commissionInfo = calculateCommissionBreakdown(grossAmount);

  return {
    id: String(row.id),
    reference: row.reference,
    version: Number(row.version || 1),
    serviceType: row.service_type,
    issueType: row.issue_type,
    vehicleId: row.vehicle_id ? String(row.vehicle_id) : '',
    vehicleLabel: row.vehicle_label,
    pickup: hasPickupCoords
      ? {
          latitude: Number(row.pickup_lat),
          longitude: Number(row.pickup_lng),
          address: row.pickup_address || 'Pickup location',
        }
      : null,
    scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
    dispatchedAt: row.dispatched_at ? new Date(row.dispatched_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    status: row.status,
    providerName: providerProfile?.display_name || 'FixMyBuddy Pro',
    quotedAmount: Number(row.quoted_amount || 0),
    ...(row.paid_amount != null ? { paidAmount: Number(row.paid_amount) } : {}),
    notes: row.notes || '',
    canCancel: preDispatch,
    canReschedule: preDispatch,
    ...(policy ? { cancellationPolicy: { id: String(policy.id), text: policy.text } } : {}),
    payment: {
      status: row.payment_status || 'unverified',
      ...(providerProfile?.payment_qr_url ? { qrUrl: providerProfile.payment_qr_url } : {}),
      payeeName:
        providerProfile?.payee_name ||
        providerProfile?.display_name ||
        'FixMyBuddy Provider',
      payeePhone: providerProfile?.provider_phone || '+639170000111',
      reference: row.payment_reference || '',
      reportable: row.payment_status === 'unverified',
      methods: ['gcash', 'qrph'],
      qrPayload: buildEmvcoQrPhPayload({
        reference: row.reference,
        payeeName:
          providerProfile?.payee_name ||
          providerProfile?.display_name ||
          'FixMyBuddy Provider',
        amount: Number(row.paid_amount ?? row.quoted_amount ?? 0),
      }),
      ...commissionInfo,
    },
    receiptAvailable: Boolean(row.receipt_available && row.payment_status === 'verified'),
    ...(row.initial_estimate ? { initialEstimate: row.initial_estimate } : {}),
    ...(row.repair_estimate ? { repairEstimate: row.repair_estimate } : {}),
    ...(row.approved_quote ? { approvedQuote: row.approved_quote } : {}),
    ...(row.pending_revision ? { pendingRevision: row.pending_revision } : {}),
    ...(row.decline_payable_estimate
      ? { declinePayableEstimate: row.decline_payable_estimate }
      : {}),
    ...(row.repair_approval_status
      ? { repairApprovalStatus: row.repair_approval_status }
      : {}),
    ...(row.revision_status ? { revisionStatus: row.revision_status } : {}),
    ...(row.inspection_status ? { inspectionStatus: row.inspection_status } : {}),
    sharing: {
      enabled: Boolean(row.sharing_enabled),
    },
    ...(mechanicState ? { mechanic: mechanicState } : {}),
    ...(towingState ? { towing: towingState } : {}),
    ...(reviewRow
      ? {
          review: {
            id: String(reviewRow.id),
            bookingId: String(row.id),
            rating: Number(reviewRow.rating),
            body: reviewRow.body || '',
            version: Number(reviewRow.version || 1),
          },
          canReview: true,
          canEditReview: true,
        }
      : {
          canReview: row.status === 'completed',
          canEditReview: row.status === 'completed',
        }),
    warranties: Array.isArray(row.warranties) ? row.warranties : [],
  };
}

function generatePdfBuffer(booking) {
  const paid = Number(booking.paid_amount || booking.quoted_amount || 0);
  const { commission, net } = calculateCommissionBreakdown(paid);
  const ref = booking.payment_reference || 'VERIFIED';
  const text = `FixMyBuddy Verified Receipt | Booking: ${booking.reference} | Ref: ${ref} | Total Paid: PHP ${paid.toFixed(2)} (Includes 5% Platform Fee: PHP ${commission.toFixed(2)} | Provider Net: PHP ${net.toFixed(2)})`;
  const stream = `BT /F1 11 Tf 32 730 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

// GET /support/config (public)
customerRouter.get('/support/config', (_req, res) => {
  res.json({
    phone: process.env.SUPPORT_PHONE || '+639170000111',
    email: process.env.SUPPORT_EMAIL || 'support@fixmybuddy.ph',
  });
});

// Require an authenticated customer (or admin) for all /customers/me/* routes
customerRouter.use('/customers/me', requireAuth(['customer']));

// PATCH /customers/me
customerRouter.patch('/customers/me', async (req, res, next) => {
  try {
    const { name, emergencyContact } = req.body || {};
    const updates = [];
    const values = [];

    if (name !== undefined) {
      const cleanName = typeof name === 'string' ? name.trim() : '';
      if (cleanName.length < 2) {
        return res.status(400).json({ error: 'Enter your full name.' });
      }
      values.push(cleanName);
      updates.push(`name = $${values.length}`);
    }

    if (emergencyContact !== undefined) {
      if (emergencyContact === null) {
        updates.push(
          `emergency_contact_name = NULL, emergency_contact_phone = NULL, emergency_contact_relationship = NULL`,
        );
        await query(
          `UPDATE bookings SET sharing_enabled = FALSE WHERE customer_id = $1`,
          [req.user.id],
        );
      } else {
        const cName = typeof emergencyContact.name === 'string' ? emergencyContact.name.trim() : '';
        const cPhone = normalizePhone(emergencyContact.phone);
        const cRel = typeof emergencyContact.relationship === 'string'
          ? emergencyContact.relationship.trim()
          : '';
        if (cName.length < 2 || !cPhone || !cRel) {
          return res.status(400).json({ error: 'Invalid emergency contact details.' });
        }
        if (cPhone === normalizePhone(req.user.phone || '')) {
          return res.status(400).json({ error: 'Choose someone other than yourself.' });
        }
        values.push(cName, cPhone, cRel);
        updates.push(
          `emergency_contact_name = $${values.length - 2}, emergency_contact_phone = $${values.length - 1}, emergency_contact_relationship = $${values.length}`,
        );
      }
    }

    if (updates.length === 0) {
      return res.json({ user: req.user });
    }

    values.push(req.user.id);
    const result = await query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values,
    );
    return res.json({ user: formatUser(result.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

// -----------------------------------------------------------------------------
// VEHICLES
// -----------------------------------------------------------------------------
customerRouter.get('/customers/me/vehicles', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM vehicles WHERE user_id = $1 ORDER BY created_at ASC`,
      [req.user.id],
    );
    return res.json({ vehicles: result.rows.map(formatVehicleRow) });
  } catch (error) {
    return next(error);
  }
});

customerRouter.post('/customers/me/vehicles', async (req, res, next) => {
  try {
    const { type, make, model, year, color, plate = '' } = req.body || {};
    if (!['car', 'motorcycle'].includes(type) || !make?.trim() || !model?.trim() || !color?.trim()) {
      return res.status(400).json({ error: 'Invalid vehicle details.' });
    }
    const cleanedPlate = cleanPlate(plate);
    const normPlate = normalizedPlateKey(plate);

    const result = await query(
      `INSERT INTO vehicles (user_id, type, make, model, year, color, plate, normalized_plate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.user.id,
        type,
        make.trim(),
        model.trim(),
        Number(year),
        color.trim(),
        cleanedPlate,
        normPlate,
      ],
    );
    return res.status(201).json({ vehicle: formatVehicleRow(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A vehicle with this plate is already saved.' });
    }
    return next(error);
  }
});

customerRouter.patch('/customers/me/vehicles/:id', async (req, res, next) => {
  try {
    const { type, make, model, year, color, plate = '' } = req.body || {};
    const cleanedPlate = cleanPlate(plate);
    const normPlate = normalizedPlateKey(plate);

    const result = await query(
      `UPDATE vehicles
       SET type = $1, make = $2, model = $3, year = $4, color = $5,
           plate = $6, normalized_plate = $7, updated_at = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING *`,
      [
        type,
        make?.trim(),
        model?.trim(),
        Number(year),
        color?.trim(),
        cleanedPlate,
        normPlate,
        req.params.id,
        req.user.id,
      ],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vehicle not found.' });
    }
    return res.json({ vehicle: formatVehicleRow(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A vehicle with this plate is already saved.' });
    }
    return next(error);
  }
});

customerRouter.delete('/customers/me/vehicles/:id', async (req, res, next) => {
  try {
    await query(
      `DELETE FROM vehicles WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

// -----------------------------------------------------------------------------
// REMINDERS
// -----------------------------------------------------------------------------
function formatReminderRow(row) {
  return {
    id: String(row.id),
    title: row.title,
    vehicleId: String(row.vehicle_id),
    dueDate: row.due_date ? new Date(row.due_date).toISOString().slice(0, 10) : '',
    targetMileage: row.target_mileage != null ? Number(row.target_mileage) : null,
    currentMileage: row.current_mileage != null ? Number(row.current_mileage) : null,
    notes: row.notes || '',
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

customerRouter.get('/customers/me/reminders', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM maintenance_reminders WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id],
    );
    return res.json({ reminders: result.rows.map(formatReminderRow) });
  } catch (error) {
    return next(error);
  }
});

customerRouter.post('/customers/me/reminders', async (req, res, next) => {
  try {
    const { title, vehicleId, dueDate, targetMileage, currentMileage, notes = '' } = req.body || {};
    const vehCheck = await query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [vehicleId, req.user.id],
    );
    if (vehCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Vehicle does not belong to your account.' });
    }
    const result = await query(
      `INSERT INTO maintenance_reminders (
         user_id, vehicle_id, title, due_date, target_mileage, current_mileage, notes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.user.id,
        vehicleId,
        title.trim(),
        dueDate || null,
        targetMileage !== '' && targetMileage != null ? Number(targetMileage) : null,
        currentMileage !== '' && currentMileage != null ? Number(currentMileage) : null,
        notes,
      ],
    );
    return res.status(201).json({ reminder: formatReminderRow(result.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

customerRouter.patch('/customers/me/reminders/:id', async (req, res, next) => {
  try {
    const existingRes = await query(
      `SELECT * FROM maintenance_reminders WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [req.params.id, req.user.id],
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Reminder not found.' });
    }
    const existing = existingRes.rows[0];
    const nextTitle = req.body.title !== undefined ? req.body.title.trim() : existing.title;
    const nextVehicleId = req.body.vehicleId !== undefined ? req.body.vehicleId : existing.vehicle_id;
    const nextDueDate = req.body.dueDate !== undefined ? req.body.dueDate || null : existing.due_date;
    const nextTarget =
      req.body.targetMileage !== undefined
        ? req.body.targetMileage !== '' && req.body.targetMileage != null
          ? Number(req.body.targetMileage)
          : null
        : existing.target_mileage;
    const nextCurrent =
      req.body.currentMileage !== undefined
        ? req.body.currentMileage !== '' && req.body.currentMileage != null
          ? Number(req.body.currentMileage)
          : null
        : existing.current_mileage;
    const nextNotes = req.body.notes !== undefined ? req.body.notes : existing.notes;
    const nextCompleted =
      req.body.completedAt !== undefined ? req.body.completedAt : existing.completed_at;

    const result = await query(
      `UPDATE maintenance_reminders
       SET title = $1, vehicle_id = $2, due_date = $3,
           target_mileage = $4, current_mileage = $5, notes = $6,
           completed_at = $7, updated_at = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING *`,
      [
        nextTitle,
        nextVehicleId,
        nextDueDate,
        nextTarget,
        nextCurrent,
        nextNotes,
        nextCompleted,
        req.params.id,
        req.user.id,
      ],
    );
    return res.json({ reminder: formatReminderRow(result.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

customerRouter.delete('/customers/me/reminders/:id', async (req, res, next) => {
  try {
    await query(
      `DELETE FROM maintenance_reminders WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

// -----------------------------------------------------------------------------
// BOOKINGS & ACTIVE SERVICE
// -----------------------------------------------------------------------------
customerRouter.get('/customers/me/bookings', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM bookings WHERE customer_id = $1 ORDER BY created_at DESC`,
      [req.user.id],
    );
    const bookings = [];
    for (const row of result.rows) {
      bookings.push(await formatBookingRow(row));
    }
    return res.json({ bookings });
  } catch (error) {
    return next(error);
  }
});

customerRouter.post('/customers/me/bookings', async (req, res, next) => {
  try {
    const {
      providerId,
      vehicleId,
      serviceType = 'mechanic',
      issueType = 'Roadside assistance',
      notes = '',
      landmark = '',
      location,
      destination,
      destinationShop,
      towingCondition,
      scheduledAt = null,
      estimateId,
      estimateVersion = 1,
      cancellationPolicyId = 'policy-standard-v1',
      repairsApproved,
    } = req.body || {};

    if (repairsApproved !== false) {
      return res.status(400).json({ error: 'Initial booking cannot pre-approve repairs.' });
    }
    if (!estimateId || !cancellationPolicyId) {
      return res.status(400).json({ error: 'Estimate and cancellation policy are required.' });
    }

    const vehRes = await query(
      `SELECT * FROM vehicles WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [vehicleId, req.user.id],
    );
    if (vehRes.rows.length === 0) {
      return res.status(403).json({ error: 'Selected vehicle does not belong to your account.' });
    }
    const veh = vehRes.rows[0];
    const vehicleLabel = `${veh.make} ${veh.model} · ${veh.year}`;

    if (!providerId || !locationIsValid(location)) return res.status(400).json({ error: 'Choose an available mechanic and valid pickup pin.' });
    const provRes = await query(`${availableMechanicSql} AND mp.id=$3 LIMIT 1`, [demoEmails, presenceMaxAgeSeconds(), providerId]);
    const prov = provRes.rows[0];
    if (!prov) return res.status(409).json({ error: 'This mechanic is no longer available. Please find another match.' });
    const distance = haversineKm(location.latitude, location.longitude, Number(prov.latitude), Number(prov.longitude));
    if (distance > Number(prov.service_radius_km)) return res.status(409).json({ error: 'Pickup is outside this mechanic’s service area.' });
    if (serviceType === 'towing' && !prov.specialties?.some(s => s.toLowerCase() === 'towing')) return res.status(409).json({ error: 'This mechanic does not provide towing.' });

    const visitEstimate = calculateDistancePricing({
      profile: prov,
      serviceType,
      distanceKm: distance,
      estimateId: String(estimateId),
      version: Number(estimateVersion || 1),
    });
    const quotedAmount = visitEstimate.total;

    const refNum = `${serviceType === 'towing' ? 'TOW' : 'FMB'}-${Math.floor(1000 + Math.random() * 9000)}`;
    const arrivalPin = generateNumericCode(4);
    const handoverPin = generateNumericCode(4);

    const insertRes = await query(
      `INSERT INTO bookings (
         id, reference, version, customer_id, provider_id, vehicle_id, vehicle_label,
         service_type, issue_type, notes, landmark, pickup_address, pickup_lat, pickup_lng,
         destination_address, destination_shop, towing_condition,
         status, scheduled_at, estimate_id, estimate_version, quoted_amount,
         cancellation_policy_id, initial_estimate,
         arrival_pin_hash, arrival_pin_plain, arrival_pin_expires_at,
         handover_pin_hash, handover_pin_plain, handover_pin_expires_at,
         mechanic_state, towing_state
       )
       VALUES (
         $1, $1, 1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10, $11, $12,
         $13, $14::jsonb, $15::jsonb,
         $16, $17, $18, $19, $20,
         $21, $22::jsonb,
         $23, $24, NOW() + INTERVAL '2 hours',
         $25, $26, NOW() + INTERVAL '4 hours',
         $27::jsonb, $28::jsonb
       )
       RETURNING *`,
      [
        refNum,
        req.user.id,
        providerId,
        veh.id,
        vehicleLabel,
        serviceType,
        issueType,
        notes,
        landmark,
        location?.address || 'Pinned location',
        location?.latitude ?? null,
        location?.longitude ?? null,
        destination || null,
        destinationShop ? JSON.stringify(destinationShop) : null,
        towingCondition ? JSON.stringify(towingCondition) : null,
        scheduledAt ? 'scheduled' : 'requested',
        scheduledAt || null,
        String(estimateId),
        Number(estimateVersion || 1),
        quotedAmount,
        cancellationPolicyId,
        JSON.stringify(visitEstimate),
        hashToken(arrivalPin),
        arrivalPin,
        hashToken(handoverPin),
        handoverPin,
        JSON.stringify({
          status: 'requested',
          updatedAt: new Date().toISOString(),
          arrivalPinAvailable: true,
          etaMinutes: Math.max(4, Math.round(distance * 4.5)),
          distanceMeters: visitEstimate.distanceMeters,
          timeline: [
            {
              id: 'confirmed',
              label: 'Booking requested',
              status: 'completed',
              at: new Date().toISOString(),
            },
            { id: 'dispatch', label: 'Awaiting mechanic dispatch', status: 'current' },
          ],
          updates: [],
        }),
        JSON.stringify({
          status: 'requested',
          canConfirmHandover: false,
          etaMinutes: Math.max(6, Math.round(distance * 4.5)),
          distanceMeters: visitEstimate.distanceMeters,
          handover: { requiresPin: true },
        }),
      ],
    );

    await query(
      `INSERT INTO notifications (user_id, booking_id, type, title, message)
       VALUES ($1, $2, 'booking_confirmed', $3, $4)`,
      [
        req.user.id,
        refNum,
        `Booking ${refNum} received`,
        `Your ${serviceType} request for ${vehicleLabel} has been sent to ${prov?.display_name || 'your provider'}.`,
      ],
    );

    const booking = await formatBookingRow(insertRes.rows[0]);
    return res.status(201).json({ booking });
  } catch (error) {
    return next(error);
  }
});

// POST /customers/me/bookings/:id/cancel & /reschedule
customerRouter.post('/customers/me/bookings/:id/:action(cancel|reschedule)', async (req, res, next) => {
  try {
    const { id, action } = req.params;
    const { cancellationPolicyId, scheduledAt, version } = req.body || {};
    const bookRes = await query(
      `SELECT * FROM bookings WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [id, req.user.id],
    );
    if (bookRes.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    const row = bookRes.rows[0];
    if (
      row.dispatched_at ||
      !['requested', 'pending', 'confirmed', 'accepted', 'scheduled'].includes(row.status) ||
      !cancellationPolicyId ||
      (version != null && Number(row.version) !== Number(version))
    ) {
      return res.status(409).json({ error: 'Booking cannot be modified in its current state.' });
    }

    if (action === 'cancel') {
      const updated = await query(
        `UPDATE bookings
         SET status = 'cancelled', version = version + 1, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id],
      );
      return res.json({ booking: await formatBookingRow(updated.rows[0]) });
    }

    if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt)) || Date.parse(scheduledAt) <= Date.now()) {
      return res.status(400).json({ error: 'Choose a valid future schedule time.' });
    }
    const updated = await query(
      `UPDATE bookings
       SET status = 'scheduled', scheduled_at = $1, version = version + 1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [new Date(scheduledAt).toISOString(), id],
    );
    return res.json({ booking: await formatBookingRow(updated.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

// PATCH /customers/me/bookings/:id/sharing
customerRouter.patch('/customers/me/bookings/:id/sharing', async (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled boolean is required.' });
    }
    if (enabled && !req.user.emergencyContact) {
      return res.status(409).json({ error: 'Add an emergency contact before enabling trip sharing.' });
    }

    const updated = await query(
      `UPDATE bookings
       SET sharing_enabled = $1, version = version + 1, updated_at = NOW()
       WHERE id = $2 AND customer_id = $3
       RETURNING sharing_enabled`,
      [enabled, req.params.id, req.user.id],
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    return res.json({ sharing: { enabled: Boolean(updated.rows[0].sharing_enabled) } });
  } catch (error) {
    return next(error);
  }
});

// POST /customers/me/bookings/:id/quote-decision
customerRouter.post('/customers/me/bookings/:id/quote-decision', async (req, res, next) => {
  try {
    const { quoteId, quoteVersion, decision, bookingVersion } = req.body || {};
    const bookRes = await query(
      `SELECT * FROM bookings WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [req.params.id, req.user.id],
    );
    if (bookRes.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    const row = bookRes.rows[0];
    const isRevision = row.revision_status === 'awaiting_customer';
    const quote = isRevision ? row.pending_revision : row.repair_estimate;

    if (
      !quote ||
      quote.id !== quoteId ||
      Number(quote.version) !== Number(quoteVersion) ||
      !['approve', 'reject'].includes(decision) ||
      Number(row.version) !== Number(bookingVersion)
    ) {
      return res.status(409).json({ error: 'Quote or booking state changed.' });
    }

    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
    const nextApprovedQuote = decision === 'approve' ? quote : row.approved_quote;
    const nextQuotedAmount =
      decision === 'approve' ? Number(quote.total) : Number(row.quoted_amount);

    const updated = await query(
      `UPDATE bookings
       SET ${isRevision ? 'revision_status' : 'repair_approval_status'} = $1,
           approved_quote = $2::jsonb,
           quoted_amount = $3,
           repairs_approved = CASE WHEN $1 = 'approved' THEN TRUE ELSE repairs_approved END,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [
        nextStatus,
        nextApprovedQuote ? JSON.stringify(nextApprovedQuote) : null,
        nextQuotedAmount,
        row.id,
      ],
    );

    const booking = await formatBookingRow(updated.rows[0]);
    return res.json({
      booking,
      decision: { quoteId: quote.id, quoteVersion: quote.version, decision },
    });
  } catch (error) {
    return next(error);
  }
});

// POST /customers/me/bookings/:id/repair-approval
customerRouter.post('/customers/me/bookings/:id/repair-approval', async (req, res, next) => {
  try {
    const updated = await query(
      `UPDATE bookings
       SET repair_approval_status = 'approved',
           approved_quote = COALESCE(repair_estimate, initial_estimate),
           repairs_approved = TRUE,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1 AND customer_id = $2
       RETURNING *`,
      [req.params.id, req.user.id],
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    return res.json({ booking: await formatBookingRow(updated.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

// POST /customers/me/bookings/:id/inspection-request
customerRouter.post('/customers/me/bookings/:id/inspection-request', async (req, res, next) => {
  try {
    const updated = await query(
      `UPDATE bookings
       SET inspection_status = 'requested', version = version + 1, updated_at = NOW()
       WHERE id = $1 AND customer_id = $2
       RETURNING *`,
      [req.params.id, req.user.id],
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    return res.json({ booking: await formatBookingRow(updated.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

// POST /customers/me/bookings/:id/payment/session (Initialize Direct In-Website GCash or QRPh Checkout Session)
customerRouter.post('/customers/me/bookings/:id/payment/session', async (req, res, next) => {
  try {
    const { method = 'gcash', phone = '' } = req.body || {};
    const bookRes = await query(
      `SELECT * FROM bookings WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [req.params.id, req.user.id],
    );
    if (bookRes.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    const row = bookRes.rows[0];
    let providerProfile = null;
    if (row.provider_id) {
      const provRes = await query(
        `SELECT p.*, u.phone AS provider_phone
         FROM mechanic_profiles p
         LEFT JOIN users u ON u.id = p.user_id
         WHERE p.id = $1 LIMIT 1`,
        [row.provider_id],
      );
      providerProfile = provRes.rows[0] || null;
    }

    const session = await createPaymentCheckoutSession({
      booking: row,
      providerProfile,
      method,
      phone: phone || req.user.phone || '',
    });

    return res.json({ session });
  } catch (error) {
    return next(error);
  }
});

// POST /customers/me/bookings/:id/pay (and /payment) (In-App GCash & QRPh Instant Checkout with 5% Platform Commission)
customerRouter.post('/customers/me/bookings/:id/:payAction(pay|payment)', async (req, res, next) => {
  try {
    const { method = 'gcash', phone = '', reference = '' } = req.body || {};
    const cleanMethod = ['gcash', 'qrph'].includes(String(method).toLowerCase())
      ? String(method).toLowerCase()
      : 'gcash';

    const bookRes = await query(
      `SELECT * FROM bookings WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [req.params.id, req.user.id],
    );
    if (bookRes.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    const row = bookRes.rows[0];
    if (row.payment_status === 'verified') {
      return res.json({ booking: await formatBookingRow(row) });
    }

    const amountDue = Number(row.quoted_amount || 0);
    const { commission, net } = calculateCommissionBreakdown(amountDue);
    const prefix = cleanMethod === 'qrph' ? 'QRPH' : 'GCASH';
    const txRef =
      String(reference || '').trim() ||
      `${prefix}-${Date.now().toString().slice(-8)}`;

    const updated = await query(
      `UPDATE bookings
       SET payment_status = 'verified',
           paid_amount = quoted_amount,
           payment_reference = $1,
           receipt_available = TRUE,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $2 AND customer_id = $3
       RETURNING *`,
      [txRef, row.id, req.user.id],
    );

    const updatedRow = updated.rows[0];

    await query(
      `INSERT INTO notifications (user_id, booking_id, type, title, message)
       VALUES ($1, $2, 'payment_verified', $3, $4)`,
      [
        req.user.id,
        row.id,
        `Payment confirmed (${txRef})`,
        `Your ${prefix} payment of ₱${amountDue.toFixed(2)} for ${row.reference} is verified. Includes 5% platform fee (₱${commission.toFixed(2)}).`,
      ],
    );

    if (row.provider_id) {
      const provUserRes = await query(
        `SELECT user_id FROM mechanic_profiles WHERE id = $1 LIMIT 1`,
        [row.provider_id],
      );
      if (provUserRes.rows[0]?.user_id) {
        await query(
          `INSERT INTO notifications (user_id, booking_id, type, title, message)
           VALUES ($1, $2, 'payment_verified', $3, $4)`,
          [
            provUserRes.rows[0].user_id,
            row.id,
            `${prefix} payment received (${row.reference})`,
            `Gross paid: ₱${amountDue.toFixed(2)} · 5% platform commission: ₱${commission.toFixed(2)} · Your net payout: ₱${net.toFixed(2)} (Ref: ${txRef}${phone ? ` · ${phone}` : ''}).`,
          ],
        );
      }
    }

    return res.json({
      booking: await formatBookingRow(updatedRow),
      payment: {
        status: 'verified',
        reference: txRef,
        method: cleanMethod,
        gross: amountDue,
        commission,
        net,
      },
    });
  } catch (error) {
    return next(error);
  }
});

// POST /customers/me/bookings/:id/payment-reports
customerRouter.post('/customers/me/bookings/:id/payment-reports', async (req, res, next) => {
  try {
    const { reference = '' } = req.body || {};
    const updated = await query(
      `UPDATE bookings
       SET payment_status = 'pending_verification',
           payment_reference = $1,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $2 AND customer_id = $3
       RETURNING payment_status`,
      [String(reference).trim() || `QRPH-${Date.now().toString().slice(-6)}`, req.params.id, req.user.id],
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    return res.json({ payment: { status: 'pending_verification' } });
  } catch (error) {
    return next(error);
  }
});

// GET /customers/me/bookings/:id/receipt
customerRouter.get('/customers/me/bookings/:id/receipt', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM bookings WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [req.params.id, req.user.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    const row = result.rows[0];
    if (row.payment_status !== 'verified' || !row.receipt_available) {
      return res.status(403).json({ error: 'Verified receipt is not available for this booking.' });
    }
    const pdf = generatePdfBuffer(row);
    res.setHeader('Content-Type', 'application/pdf');
    return res.send(pdf);
  } catch (error) {
    return next(error);
  }
});

// PUT /customers/me/bookings/:id/review
customerRouter.put('/customers/me/bookings/:id/review', async (req, res, next) => {
  try {
    const { rating, body = '', clientId = '', version } = req.body || {};
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || typeof body !== 'string' || body.length > 2000 || typeof clientId !== 'string' || clientId.length > 128) {
      return res.status(400).json({ error: 'Provide a 1–5 star rating and a review up to 2000 characters.' });
    }
    const review = await withTransaction(async client => {
      const books = await client.query('SELECT * FROM bookings WHERE id=$1 AND customer_id=$2 FOR UPDATE',[req.params.id,req.user.id]);
      const booking = books.rows[0];
      if (!booking) { const error=new Error('Booking not found.'); error.status=404; throw error; }
      if (booking.status !== 'completed' || !booking.provider_id) { const error=new Error('Only completed services with an assigned provider can be rated.'); error.status=409; throw error; }
      await client.query('SELECT id FROM mechanic_profiles WHERE id=$1 FOR UPDATE',[booking.provider_id]);
      const previous = (await client.query('SELECT * FROM booking_reviews WHERE booking_id=$1',[booking.id])).rows[0];
      if (previous && clientId && previous.client_id === clientId) {
        if (previous.rating !== rating || previous.body !== body.trim()) { const error=new Error('This review request ID was already used.'); error.status=409; throw error; }
        return previous;
      }
      if (previous && Number(version) !== previous.version) { const error=new Error('This review has changed. Refresh before editing.'); error.status=409; throw error; }
      const result = await client.query(`INSERT INTO booking_reviews (booking_id,customer_id,provider_id,rating,body,version,client_id)
        VALUES ($1,$2,$3,$4,$5,1,$6)
        ON CONFLICT (booking_id) DO UPDATE SET rating=EXCLUDED.rating,body=EXCLUDED.body,
          client_id=EXCLUDED.client_id,version=booking_reviews.version+1,updated_at=NOW()
        RETURNING *`,[booking.id,req.user.id,booking.provider_id,rating,body.trim(),clientId]);
      await client.query(`UPDATE mechanic_profiles SET rating=(SELECT round(avg(rating),2) FROM booking_reviews WHERE provider_id=$1),
        reviews_count=(SELECT count(*) FROM booking_reviews WHERE provider_id=$1) WHERE id=$1`,[booking.provider_id]);
      return result.rows[0];
    });
    return res.json({ review: { id:String(review.id), bookingId:String(review.booking_id), rating:Number(review.rating), body:review.body, version:Number(review.version) } });
  } catch (error) { return next(error); }
});

// GET /customers/me/bookings/:id/mechanic/arrival-pin
customerRouter.get('/customers/me/bookings/:id/mechanic/arrival-pin', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM bookings WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [req.params.id, req.user.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    const row = result.rows[0];
    if (row.arrival_verified_at || !row.arrival_pin_plain) {
      return res.status(404).json({ error: 'Arrival PIN is no longer active.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      bookingId: String(row.id),
      pin: String(row.arrival_pin_plain),
      expiresAt: row.arrival_pin_expires_at
        ? new Date(row.arrival_pin_expires_at).toISOString()
        : new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    return next(error);
  }
});

registerBookingMessages(customerRouter, '/customers/me/bookings', 'customer');

// POST /customers/me/bookings/:id/towing/handover
customerRouter.post('/customers/me/bookings/:id/towing/handover', async (req, res, next) => {
  try {
    let details = req.body?.details || req.body || {};
    if (typeof details === 'string') {
      details = JSON.parse(details);
    }
    const { condition, vehicleReceived, keysReceived, damageNotes = '', pin } = details;
    const bookRes = await query(
      `SELECT * FROM bookings WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [req.params.id, req.user.id],
    );
    if (bookRes.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    const row = bookRes.rows[0];
    if (
      !['no_new_damage', 'damage_reported'].includes(condition) ||
      vehicleReceived !== true ||
      keysReceived !== true
    ) {
      return res.status(409).json({ error: 'Invalid handover confirmation fields.' });
    }
    if (row.handover_pin_hash && pin && !verifyTokenHash(String(pin).trim(), row.handover_pin_hash)) {
      return res.status(409).json({ error: 'Invalid handover PIN.' });
    }

    const handover = {
      id: `HO-${row.id}`,
      status: 'confirmed',
      condition,
      damageNotes,
      keysReceived: true,
      vehicleReceived: true,
    };
    const nextTowingState = {
      ...(row.towing_state || {}),
      canConfirmHandover: false,
      handover,
    };

    await query(
      `UPDATE bookings
       SET towing_state = $1::jsonb,
           handover_pin_plain = NULL,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(nextTowingState), row.id],
    );

    return res.json({ handover });
  } catch (error) {
    return next(error);
  }
});

// -----------------------------------------------------------------------------
// UPDATES (NOTIFICATIONS), SUPPORT MESSAGES & DISPUTES
// -----------------------------------------------------------------------------
customerRouter.get('/customers/me/updates', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id],
    );
    return res.json({
      updates: result.rows.map((u) => ({
        id: String(u.id),
        type: u.type,
        title: u.title,
        message: u.message,
        bookingId: u.booking_id || undefined,
        read: Boolean(u.read),
        readAt: u.read_at ? new Date(u.read_at).toISOString() : null,
        createdAt: new Date(u.created_at).toISOString(),
      })),
    });
  } catch (error) {
    return next(error);
  }
});

customerRouter.post('/customers/me/updates/read', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (ids.length === 0) return res.json({ readIds: [] });

    const result = await query(
      `UPDATE notifications
       SET read = TRUE, read_at = NOW()
       WHERE user_id = $1 AND id::text = ANY($2::text[])
       RETURNING id`,
      [req.user.id, ids],
    );
    return res.json({ readIds: result.rows.map((r) => String(r.id)) });
  } catch (error) {
    return next(error);
  }
});

customerRouter.get('/customers/me/support/messages', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM support_messages WHERE user_id = $1 ORDER BY created_at ASC`,
      [req.user.id],
    );
    return res.json({
      messages: result.rows.map((m) => ({
        id: String(m.id),
        sender: m.sender,
        body: m.body,
        clientId: m.client_id,
        createdAt: new Date(m.created_at).toISOString(),
      })),
    });
  } catch (error) {
    return next(error);
  }
});

customerRouter.post('/customers/me/support/messages', async (req, res, next) => {
  try {
    const { body, clientId } = req.body || {};
    const cleanBody = typeof body === 'string' ? body.trim() : '';
    if (!cleanBody || cleanBody.length > 2000 || !clientId) {
      return res.status(400).json({ error: 'Message body and clientId are required.' });
    }
    const result = await query(
      `INSERT INTO support_messages (user_id, sender, body, client_id)
       VALUES ($1, 'customer', $2, $3)
       ON CONFLICT (user_id, client_id) DO UPDATE SET body = EXCLUDED.body
       RETURNING *`,
      [req.user.id, cleanBody, String(clientId)],
    );
    const m = result.rows[0];
    return res.status(201).json({
      message: {
        id: String(m.id),
        sender: m.sender,
        body: m.body,
        clientId: m.client_id,
        createdAt: new Date(m.created_at).toISOString(),
      },
    });
  } catch (error) {
    return next(error);
  }
});

customerRouter.get('/customers/me/disputes', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM disputes WHERE user_id = $1 ORDER BY updated_at DESC`,
      [req.user.id],
    );
    return res.json({
      disputes: result.rows.map((d) => ({
        id: String(d.id),
        reference: d.reference,
        bookingId: d.booking_id || undefined,
        reason: d.reason,
        subject: d.subject,
        description: d.description,
        amountInQuestion: d.amount_in_question != null ? Number(d.amount_in_question) : null,
        currency: d.currency,
        status: d.status,
        updatedAt: new Date(d.updated_at).toISOString(),
      })),
    });
  } catch (error) {
    return next(error);
  }
});

customerRouter.post('/customers/me/disputes', async (req, res, next) => {
  try {
    let details = req.body?.details || req.body || {};
    if (typeof details === 'string') {
      details = JSON.parse(details);
    }
    const {
      bookingId = null,
      reason = 'service',
      subject = '',
      description = '',
      amountInQuestion = null,
      clientId = crypto.randomUUID(),
    } = details;

    if (!subject.trim() || !description.trim()) {
      return res.status(400).json({ error: 'Subject and description are required.' });
    }

    const ref = `CL-${Math.floor(100 + Math.random() * 900)}`;
    const result = await query(
      `INSERT INTO disputes (
         reference, user_id, booking_id, reason, subject, description,
         amount_in_question, status, client_id, evidence
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted', $8, $9::jsonb)
       ON CONFLICT (user_id, client_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [
        ref,
        req.user.id,
        bookingId || null,
        reason,
        subject.trim(),
        description.trim(),
        amountInQuestion != null && amountInQuestion !== '' ? Number(amountInQuestion) : null,
        String(clientId),
        JSON.stringify(req.evidenceFiles || []),
      ],
    );

    const d = result.rows[0];
    return res.status(201).json({
      dispute: {
        id: String(d.id),
        reference: d.reference,
        bookingId: d.booking_id || undefined,
        reason: d.reason,
        subject: d.subject,
        description: d.description,
        amountInQuestion: d.amount_in_question != null ? Number(d.amount_in_question) : null,
        currency: d.currency,
        status: d.status,
        updatedAt: new Date(d.updated_at).toISOString(),
      },
    });
  } catch (error) {
    return next(error);
  }
});
