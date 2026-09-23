// Thin wrapper around Resend. Same degrade-gracefully pattern as
// metaClient.js/razorpayClient.js: without RESEND_API_KEY configured, this
// logs that an email was attempted instead of throwing, so password
// reset/verification/admin-invite flows still complete end-to-end in
// dev/CI without a real email account — but the email BODY (subject/html)
// is deliberately never logged, only that a send to this address was
// attempted. `html` for a password-reset or invite email contains a live,
// single-use token — logging it puts that token anywhere server logs are
// readable, which is as good as handing out the account. If you need the
// real link during local testing, read it out of `auth_tokens`/the DB
// directly, or configure a real RESEND_API_KEY.
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[emailService] RESEND_API_KEY not set — email not delivered (attempted send to ${to})`);
    return { sent: false, reason: 'not_configured' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Matches .env.example's own placeholder exactly — previously drifted
      // ('noreply@example.com' here vs 'noreply@yourdomain.com' there),
      // harmless while EMAIL_FROM is always meant to be overridden, but
      // worth keeping the two in sync rather than two different-looking
      // placeholders for the same unset case.
      from: process.env.EMAIL_FROM || 'Wasi CRM <noreply@yourdomain.com>',
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message || `Resend API error (${res.status})`);
  }
  return { sent: true };
}

module.exports = { sendEmail };
