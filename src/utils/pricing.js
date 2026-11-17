import process from 'node:process';

export const PLATFORM_COMMISSION_RATE = Number(
  process.env.PLATFORM_COMMISSION_RATE || 0.05,
);

export const PRICING_STEP_METERS = Math.max(
  50,
  Number(process.env.PRICING_STEP_METERS || 100),
);

export const MECHANIC_RATE_PER_STEP_PHP = Number(
  process.env.MECHANIC_RATE_PER_STEP_PHP || 5,
);

export const TOWING_RATE_PER_STEP_PHP = Number(
  process.env.TOWING_RATE_PER_STEP_PHP || 12,
);

export const TOWING_BASE_HOOKUP_PHP = Number(
  process.env.TOWING_BASE_HOOKUP_PHP || 800,
);

/**
 * Calculates distance-based visit/towing pricing based on exact meter steps
 * (default: every 100 meters) between the customer and service provider,
 * plus calculates the 5% FixMyBuddy platform commission.
 */
export function calculateDistancePricing({
  profile,
  serviceType = 'mechanic',
  distanceKm = 1.5,
  estimateId,
  version = 1,
} = {}) {
  const safeDistanceKm =
    Number.isFinite(Number(distanceKm)) && Number(distanceKm) > 0
      ? Number(distanceKm)
      : 1.0;

  const distanceMeters = Math.max(100, Math.round(safeDistanceKm * 1000));
  const stepMeters = PRICING_STEP_METERS;
  const steps = Math.max(1, Math.ceil(distanceMeters / stepMeters));

  const isTowing = serviceType === 'towing';
  const ratePerStep = isTowing
    ? TOWING_RATE_PER_STEP_PHP
    : MECHANIC_RATE_PER_STEP_PHP;
  const distanceFee = Math.round(steps * ratePerStep * 100) / 100;

  const baseCalloutFee = Number(profile?.base_visit_fee || 250);
  const diagnosisFee = Number(profile?.diagnosis_fee || 150);

  const items = isTowing
    ? [
        {
          label: 'Flatbed dispatch & hook-up',
          amount: TOWING_BASE_HOOKUP_PHP,
        },
        {
          label: `Towing distance (${distanceMeters.toLocaleString('en-PH')} m · ₱${ratePerStep}/${stepMeters}m)`,
          amount: distanceFee,
        },
      ]
    : [
        {
          label: 'Roadside call-out',
          amount: baseCalloutFee,
        },
        {
          label: 'On-site diagnosis',
          amount: diagnosisFee,
        },
        {
          label: `Distance fee (${distanceMeters.toLocaleString('en-PH')} m · ₱${ratePerStep}/${stepMeters}m)`,
          amount: distanceFee,
        },
      ];

  const total =
    Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
  const platformCommission =
    Math.round(total * PLATFORM_COMMISSION_RATE * 100) / 100;
  const providerNet = Math.round((total - platformCommission) * 100) / 100;

  const id =
    estimateId ||
    `EST-${profile?.id || 'PRO'}-${isTowing ? 'TOWING' : 'MECHANIC'}`;

  return {
    id: String(id),
    version: Number(version || 1),
    currency: 'PHP',
    items,
    total,
    distanceMeters,
    stepMeters,
    ratePerStep,
    platformCommissionRate: PLATFORM_COMMISSION_RATE,
    platformCommission,
    providerNet,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
}

/**
 * Calculates the 5% platform commission and 95% net provider payout for any gross PHP amount.
 */
export function calculateCommissionBreakdown(grossAmount = 0) {
  const gross = Math.max(0, Number(grossAmount || 0));
  const commission = Math.round(gross * PLATFORM_COMMISSION_RATE * 100) / 100;
  const net = Math.round((gross - commission) * 100) / 100;
  return {
    gross,
    commissionRate: PLATFORM_COMMISSION_RATE,
    commission,
    net,
  };
}
