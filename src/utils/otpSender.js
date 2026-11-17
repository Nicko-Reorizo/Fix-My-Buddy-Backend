// Compatibility shim: email/password authentication never generates or sends SMS.
export async function sendOtpSms() {
  return { delivered: false, channel: 'disabled' };
}
