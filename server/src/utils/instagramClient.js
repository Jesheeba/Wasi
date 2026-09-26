// Thin wrapper around the Meta Graph API for Instagram DM Automation, Phase 1
// (connect a Facebook Page's linked Instagram professional account, send/
// receive DMs). Sibling to metaClient.js, not an addition to it — that file
// is already large and entirely WhatsApp Cloud API/message-template
// specific, and every Instagram-relevant Graph endpoint here has a
// genuinely different shape (Page-scoped nodes, no messaging_product
// envelope, no templates). Reuses metaClient's generic OAuth/Graph plumbing
// (graphFetch, exchangeCodeForToken, exchangeForLongLivedToken, debugToken)
// rather than duplicating fetch/timeout/error-parsing logic.
const { graphFetch } = require('./metaClient');

// Facebook Login for Business token -> every Page this user manages, with
// its linked Instagram professional account if one exists. A Page with no
// instagram_business_account field can't receive Instagram DMs at all and
// is filtered out by the caller (routes/onboarding.js), not here — this
// function reports what Meta actually returned, unfiltered.
async function listManagedPages(accessToken) {
  const data = await graphFetch('/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}', { accessToken });
  return data.data || []; // [{ id, name, access_token, instagram_business_account?: { id, username } }, ...]
}

// Subscribes Wasi's app to this Page's messaging webhooks — the Instagram/
// Messenger Platform analog of metaClient.subscribeAppToWaba. subscribed_fields
// scoped to what Phase 1 actually handles (inbound DMs); no template-status
// or account-update analog exists for Instagram.
async function subscribePageApp(pageId, accessToken) {
  return graphFetch(`/${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks`, { method: 'POST', accessToken });
}

// Instagram Messaging API's Send API — genuinely different envelope from
// WhatsApp's messaging_product:'whatsapp' shape (metaClient.sendTextMessage),
// not a parameterization of it. Sends through the Page node using the
// Page's own access token (the same token instagram_accounts.access_token_encrypted
// stores — Instagram DMs authenticate via the linked Page, not a separate
// IG-account token).
async function sendInstagramMessage(pageId, accessToken, recipientIgScopedId, { text }) {
  const data = await graphFetch(`/${pageId}/messages`, {
    method: 'POST',
    accessToken,
    body: {
      recipient: { id: recipientIgScopedId },
      message: { text },
    },
  });
  return data; // { recipient_id, message_id }
}

module.exports = { listManagedPages, subscribePageApp, sendInstagramMessage };
