// Sends a WhatsApp template message FROM Wasi's own platform WABA TO one of
// Wasi's own clients — payment reminders, suspension warnings, suspension
// notices. Deliberately a separate module from alertNotifier.js, not a
// shared helper: alertNotifier sends internal-ops alerts to Wasi's own
// staff by repurposing whichever client's WABA happens to be connected
// (harmless there — nothing external ever sees it). This module reaches an
// EXTERNAL client, who would see the message arrive from a *different*
// Wasi client's business identity if the same "any connected WABA" shortcut
// were reused here — confusing, a quality-rating risk to an uninvolved
// third party, and a policy risk (see this file's env var comment below).
// PAYMENT_REMINDER_WABA_ID is therefore its own, separate config, expected
// to point at Wasi's own dedicated WABA once one exists — never at
// ALERT_WABA_ID's borrowed client number.
const metaClient = require('../utils/metaClient');
const wabasRepo = require('../repositories/wabasRepo');
const { decrypt } = require('../utils/encryption');

class ClientNotifyError extends Error {}

// name/language/bodyParams describe an already-approved WhatsApp template
// (see this feature's 3 candidate templates, held for review — Part C).
// Every caller in this feature is best-effort by design (a reminder/warning
// that fails to send should never abort the runner's tick for every other
// client) — callers catch and log, this function just throws with a clear
// reason so the caller's log line says something real.
async function sendTemplateToClient(client, { name, language = 'en_US', bodyParams = {} }) {
  const to = client.contact_phone;
  if (!to) {
    throw new ClientNotifyError(`${client.name} (${client.id}) has no contact_phone on file — nothing to send to.`);
  }

  const wabaId = process.env.PAYMENT_REMINDER_WABA_ID;
  if (!wabaId) {
    throw new ClientNotifyError('PAYMENT_REMINDER_WABA_ID is not configured — see .env.example.');
  }

  const waba = await wabasRepo.findByWabaId(wabaId);
  if (!waba || !waba.access_token_encrypted) {
    throw new ClientNotifyError('PAYMENT_REMINDER_WABA_ID does not match a connected WABA.');
  }

  const accessToken = decrypt(waba.access_token_encrypted);
  await metaClient.sendTemplateMessage(waba.phone_number_id, accessToken, to, {
    name,
    language,
    components: metaClient.buildNamedBodyComponents(bodyParams),
  });
}

module.exports = { sendTemplateToClient, ClientNotifyError };
