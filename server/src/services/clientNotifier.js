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

// The number to message: the client's own contact_phone if one is on file,
// otherwise the WhatsApp number connected to their WABA (display_phone_number,
// e.g. "+91 99522 70424"). Returned as digits only, which is what Meta's
// `to` field expects. Null if neither exists.
async function resolveRecipientPhone(client) {
  if (client.contact_phone) return client.contact_phone;
  const waba = await wabasRepo.findByClientId(client.id);
  const digits = (waba?.display_phone_number || '').replace(/\D/g, '');
  return digits || null;
}

// Every billing message is sent FROM the Wasi Demo Client's WABA � by direct
// instruction, that account is Wasi's own sender identity. The default is that
// client's connected WABA, so a deployed server works with no extra config;
// PAYMENT_REMINDER_WABA_ID, when set, overrides it (to move the sender to a
// different Wasi-owned WABA later). Never falls back to any other client's WABA.
const WASI_SENDER_CLIENT_ID = process.env.DEV_CLIENT_ID || '00000000-0000-0000-0000-000000000001';

async function resolveSenderWaba() {
  const overrideId = process.env.PAYMENT_REMINDER_WABA_ID;
  const waba = overrideId
    ? await wabasRepo.findByWabaId(overrideId)
    : await wabasRepo.findByClientId(WASI_SENDER_CLIENT_ID);
  if (!waba || !waba.access_token_encrypted) {
    throw new ClientNotifyError(overrideId
      ? 'PAYMENT_REMINDER_WABA_ID does not match a connected WABA.'
      : 'The Wasi Demo Client has no connected WhatsApp account to send from.');
  }
  return waba;
}

// name/language/bodyParams describe an already-approved WhatsApp template
// (see this feature's 3 candidate templates, held for review — Part C).
// Every caller in this feature is best-effort by design (a reminder/warning
// that fails to send should never abort the runner's tick for every other
// client) — callers catch and log, this function just throws with a clear
// reason so the caller's log line says something real.
async function sendTemplateToClient(client, { name, language = 'en_US', bodyParams = {} }) {
  const to = await resolveRecipientPhone(client);
  if (!to) {
    throw new ClientNotifyError(`${client.name} (${client.id}) has no contact_phone and no connected WhatsApp number on file — nothing to send to.`);
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
  // Returns Meta's message id (wamid) so the caller can log it and match
  // later delivered/read webhooks back to this send.
  return metaClient.sendTemplateMessage(waba.phone_number_id, accessToken, to, {
    name,
    language,
    components: metaClient.buildNamedBodyComponents(bodyParams),
  });
}

module.exports = { sendTemplateToClient, resolveRecipientPhone, resolveSenderWaba, ClientNotifyError };
