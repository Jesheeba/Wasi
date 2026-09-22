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
// Property access (emailService.sendEmail), not destructured — matches the
// mockable-module convention consentRepo.js/alertRunner.js already use
// (require the module, call it as a property), which lets a test monkey-
// patch emailService.sendEmail on the shared required object and have this
// file's own call pick it up. A destructured `const { sendEmail } = ...`
// binds to the function at require time and can't be intercepted that way
// — found while writing this file's own test (server/test/
// alertingConfigAndTestAlert.test.js), whose stub silently never fired
// until this was fixed.
const emailService = require('../utils/emailService');
const metaClient = require('../utils/metaClient');
const wabasRepo = require('../repositories/wabasRepo');
const { decrypt } = require('../utils/encryption');

// notify() returns { email, whatsapp } — each a
// { attempted, sent, error, reason? } result — added for the admin "Send
// test alert" button (routes/admin.js's POST /alerts/test), which needs to
// show the real outcome, including Resend's/Meta's exact error text, rather
// than a bare "sent" toast. Purely additive: every existing caller
// (alertRunner.js's reconcile(), chatSlaLogsRepo.alertOnWriteFailure,
// consentRepo.recordOptOutDurable) already ignores the return value and
// relies only on this never throwing — both preserved unchanged, so none of
// them needed to change for this.
async function notify(alertEvent) {
  const subject = `[Wasi ${alertEvent.severity.toUpperCase()}] ${alertEvent.alert_type}`;
  const html = `<p>${alertEvent.message}</p><pre>${JSON.stringify(alertEvent.details, null, 2)}</pre>`;

  const email = await sendEmailChannel(subject, html);
  const whatsapp = await sendWhatsAppChannel(subject, alertEvent.message);
  return { email, whatsapp };
}

async function sendEmailChannel(subject, html) {
  const emailTo = process.env.ALERT_EMAIL_TO;
  if (!emailTo) {
    console.log(`[alertNotifier] ALERT_EMAIL_TO not set — would have sent: ${subject}`);
    return { attempted: false, sent: false, error: null, reason: 'ALERT_EMAIL_TO is not set' };
  }
  try {
    await emailService.sendEmail({ to: emailTo, subject, html });
    return { attempted: true, sent: true, error: null };
  } catch (err) {
    // err.message here is Resend's own real error text (emailService.js
    // throws data.message straight through) — surfaced as-is, not
    // paraphrased, so the test-alert button can show exactly what Resend
    // said.
    console.error('alertNotifier: email send failed:', err.message);
    return { attempted: true, sent: false, error: err.message };
  }
}

// Requires a pre-approved 'wasi_ops_alert' Utility template (one named body
// param, e.g. {{alert_message}}) — creating and getting it approved is a
// one-time manual step outside this codebase (template approval takes real
// time, as this session's own production testing showed), so this is
// expected to no-op until that exists. A proactive message to a number with
// no open session can only be a template send, never free text.
async function sendWhatsAppChannel(subject, message) {
  const to = process.env.ALERT_WHATSAPP_TO;
  const wabaId = process.env.ALERT_WABA_ID;
  if (!to || !wabaId) {
    return { attempted: false, sent: false, error: null, reason: 'ALERT_WHATSAPP_TO/ALERT_WABA_ID are not both set' };
  }

  try {
    const waba = await wabasRepo.findByWabaId(wabaId);
    if (!waba || !waba.access_token_encrypted) {
      const reason = 'ALERT_WABA_ID does not match a connected WABA';
      console.error(`alertNotifier: ${reason} — skipping WhatsApp alert`);
      return { attempted: false, sent: false, error: reason };
    }
    const accessToken = decrypt(waba.access_token_encrypted);
    await metaClient.sendTemplateMessage(waba.phone_number_id, accessToken, to, {
      name: 'wasi_ops_alert',
      language: 'en_US',
      components: metaClient.buildNamedBodyComponents({ alert_message: `${subject}: ${message}`.slice(0, 300) }),
    });
    return { attempted: true, sent: true, error: null };
  } catch (err) {
    // Never fatal — email already carries this alert. Most likely cause
    // right now: wasi_ops_alert doesn't exist/isn't approved yet.
    // err.metaError (see metaClient.js's graphFetch) is Meta's own raw
    // error body when the failure was a real Graph API rejection — carried
    // through so the test-alert button can show Meta's exact wording, not
    // just the summarized message.
    console.error('alertNotifier: WhatsApp send failed (non-fatal, email already sent):', err.message);
    return { attempted: true, sent: false, error: err.message, metaError: err.metaError || null };
  }
}

module.exports = { notify };
