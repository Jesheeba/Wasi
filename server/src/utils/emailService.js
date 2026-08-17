// Thin wrapper around Resend. Same degrade-gracefully pattern as
// metaClient.js/razorpayClient.js: without RESEND_API_KEY configured, this
// logs the email to the console instead of throwing, so password
// reset/verification/admin-invite flows are still testable end-to-end in
// dev/CI without a real email account — the link just shows up in server logs.
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[emailService] RESEND_API_KEY not set — would have sent to ${to}: "${subject}"\n${html}`);
    return { sent: false, reason: 'not_configured' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'Wasi CRM <noreply@example.com>',
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
