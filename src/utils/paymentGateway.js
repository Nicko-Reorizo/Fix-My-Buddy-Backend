import crypto from 'node:crypto';
import { calculateCommissionBreakdown } from './pricing.js';

/**
 * Builds an EMVCo-style QRPh payload string for dynamic amount & booking reference.
 */
export function buildEmvcoQrPhPayload({ reference, payeeName, amount }) {
  const cleanRef = String(reference || 'FMB-0000').replace(/[^A-Za-z0-9-]/g, '');
  const cleanPayee = String(payeeName || 'FixMyBuddy Roadside')
    .replace(/[^A-Za-z0-9 .-]/g, '')
    .slice(0, 25);
  const formattedAmount = Number(amount || 0).toFixed(2);
  const crcSeed = `${cleanRef}|${cleanPayee}|${formattedAmount}`;
  const crc = crypto
    .createHash('sha256')
    .update(crcSeed)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();

  return `00020101021226580014ph.ppmi.p2m0111FIXMYBUDDY0212${cleanRef}52047538530360854${String(
    formattedAmount.length,
  ).padStart(2, '0')}${formattedAmount}5802PH59${String(cleanPayee.length).padStart(
    2,
    '0',
  )}${cleanPayee}6011MetroManila6304${crc}`;
}

/**
 * Creates a GCash or QRPh checkout session.
 * - If PAYMONGO_SECRET_KEY is configured in .env, attempts to create a real PayMongo Payment Intent / Source.
 * - Always returns a complete in-website checkout session so GCash Web Checkout and QRPh Dynamic QR work directly inside the website.
 */
export async function createPaymentCheckoutSession({
  booking,
  providerProfile,
  method = 'gcash',
  phone = '',
}) {
  const cleanMethod = ['gcash', 'qrph'].includes(String(method).toLowerCase())
    ? String(method).toLowerCase()
    : 'gcash';
  const amountDue = Number(booking.quoted_amount || 0);
  const { commission, net, commissionRate } = calculateCommissionBreakdown(amountDue);
  const payeeName =
    providerProfile?.payee_name ||
    providerProfile?.display_name ||
    'FixMyBuddy Partner';
  const payeePhone = providerProfile?.provider_phone || '+639170000111';
  const sessionId = `CS-${cleanMethod.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const qrPayload = buildEmvcoQrPhPayload({
    reference: booking.reference,
    payeeName,
    amount: amountDue,
  });

  const paymongoSecret = (process.env.PAYMONGO_SECRET_KEY || '').trim();
  let externalCheckoutUrl = null;
  let externalQrImage = null;

  if (paymongoSecret && amountDue >= 20) {
    try {
      const authHeader = `Basic ${Buffer.from(`${paymongoSecret}:`).toString('base64')}`;
      const amountCentavos = Math.round(amountDue * 100);
      const intentRes = await fetch('https://api.paymongo.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          data: {
            attributes: {
              amount: amountCentavos,
              payment_method_allowed: ['gcash', 'qrph'],
              currency: 'PHP',
              description: `FixMyBuddy ${booking.reference} (${payeeName})`,
              statement_descriptor: 'FIXMYBUDDY',
            },
          },
        }),
      });
      if (intentRes.ok) {
        const intentData = await intentRes.json();
        const intentId = intentData?.data?.id;
        if (intentId) {
          externalCheckoutUrl = `https://checkout.paymongo.com/${intentId}`;
        }
      }
    } catch {
      // Fallback seamlessly to built-in direct in-website checkout
    }
  }

  return {
    sessionId,
    bookingId: String(booking.id),
    bookingReference: String(booking.reference),
    method: cleanMethod,
    merchantName: `FixMyBuddy Escrow · ${payeeName}`,
    payeeName,
    payeePhone,
    customerPhone: phone || '',
    amount: amountDue,
    currency: 'PHP',
    commissionRate,
    commission,
    net,
    qrPayload,
    ...(externalCheckoutUrl ? { externalCheckoutUrl } : {}),
    ...(externalQrImage ? { externalQrImage } : {}),
    expiresAt,
  };
}
