// The one place every billing-related client message goes through, so every
// attempt — successful or not — lands in payment_notifications. Calls
// clientNotifier.sendTemplateToClient via its module object (not a
// destructured binding) so tests can stub it, same convention as the rest of
// this codebase's services.
const clientNotifier = require('./clientNotifier');
const paymentNotificationsRepo = require('../repositories/paymentNotificationsRepo');

// Never throws on a send failure: it is recorded as a 'failed' row (with the
// real reason) and reported via the return value, so one client's failure
// can't abort a bulk loop. Throws only if the audit insert itself fails.
async function sendAndLog(client, { kind, trigger, name, bodyParams, triggeredBy }) {
  let status = 'sent';
  let metaMessageId = null;
  let errorMessage = null;
  // Logged phone is the one actually used (contact_phone, else the WABA's
  // number), so the audit page shows where the message really went.
  let recipientPhone = client.contact_phone;
  try {
    recipientPhone = (await clientNotifier.resolveRecipientPhone(client)) || recipientPhone;
  } catch (_) { /* a lookup failure surfaces below via the send itself */ }
  try {
    metaMessageId = (await clientNotifier.sendTemplateToClient(client, { name, bodyParams })) || null;
  } catch (err) {
    status = 'failed';
    errorMessage = err.message;
  }
  const row = await paymentNotificationsRepo.record({
    client_id: client.id,
    client_name: client.name,
    recipient_phone: recipientPhone,
    kind, trigger, template_name: name, status,
    meta_message_id: metaMessageId,
    error_message: errorMessage,
    triggered_by: triggeredBy,
  });
  return { ok: status === 'sent', row, error: errorMessage };
}

module.exports = { sendAndLog };
