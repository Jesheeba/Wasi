// Email is the primary channel, always attempted first, because it doesn't
// depend on the thing half of these alerts are about — WhatsApp/Meta being
// broken is a real alert condition (webhook_silence, sustained_failures),
// so making WhatsApp the only or primary delivery channel would mean the
// alert can't reach anyone in exactly the scenario it exists to report.
// WhatsApp is a secondary, best-effort channel: fast attention when Meta is
// healthy, silently skipped when either ALERT_WHATSAPP_TO/ALERT_WABA_ID
// aren't set or the send itself fails — same degrade-gracefully convention
// as every other optional integration in this codebase (RESEND_API_KEY,
// META_APP_ID, etc.).
const { sendEmail } = require('../utils/emailService');
const metaClient = require('../utils/metaClient');
const wabasRepo = require('../repositories/wabasRepo');
const { decrypt } = require('../utils/encryption');

async function notify(alertEvent) {
  const subject = `[Wasi ${alertEvent.severity.toUpperCase()}] ${alertEvent.alert_type}`;
  const html = `<p>${alertEvent.message}</p><pre>${JSON.stringify(alertEvent.details, null, 2)}</pre>`;

  const emailTo = process.env.ALERT_EMAIL_TO;
  if (emailTo) {
    try {
      await sendEmail({ to: emailTo, subject, html });
    } catch (err) {
      console.error('alertNotifier: email send failed:', err.message);
    }
  } else {
    console.log(`[alertNotifier] ALERT_EMAIL_TO not set — would have sent: ${subject}\n${alertEvent.message}`);
  }

  await sendWhatsAppBestEffort(subject, alertEvent.message);
}

// Requires a pre-approved 'wasi_ops_alert' Utility template (one named body
// param, e.g. {{alert_message}}) — creating and getting it approved is a
// one-time manual step outside this codebase (template approval takes real
// time, as this session's own production testing showed), so this is
// expected to no-op until that exists. A proactive message to a number with
// no open session can only be a template send, never free text.
async function sendWhatsAppBestEffort(subject, message) {
  const to = process.env.ALERT_WHATSAPP_TO;
  const wabaId = process.env.ALERT_WABA_ID;
  if (!to || !wabaId) return;

  try {
    const waba = await wabasRepo.findByWabaId(wabaId);
    if (!waba || !waba.access_token_encrypted) {
      console.error('alertNotifier: ALERT_WABA_ID does not match a connected WABA — skipping WhatsApp alert');
      return;
    }
    const accessToken = decrypt(waba.access_token_encrypted);
    await metaClient.sendTemplateMessage(waba.phone_number_id, accessToken, to, {
      name: 'wasi_ops_alert',
      language: 'en_US',
      components: metaClient.buildNamedBodyComponents({ alert_message: `${subject}: ${message}`.slice(0, 300) }),
    });
  } catch (err) {
    // Never fatal — email already carries this alert. Most likely cause
    // right now: wasi_ops_alert doesn't exist/isn't approved yet.
    console.error('alertNotifier: WhatsApp send failed (non-fatal, email already sent):', err.message);
  }
}

module.exports = { notify };
