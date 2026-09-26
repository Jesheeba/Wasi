// Shared Instagram-connection logic (Instagram DM Automation, Phase 1),
// mirroring wabaConnectionService.js's shape — discovery + a completion
// tail, factored out so a future admin manual-resolution route (Phase 2, if
// real-world testing shows it's needed) can reuse the same completion logic
// a direct client connect uses today.
const instagramAccountsRepo = require('../repositories/instagramAccountsRepo');
const clientsRepo = require('../repositories/clientsRepo');
const instagramClient = require('../utils/instagramClient');
const { encrypt } = require('../utils/encryption');

// GET /me/accounts is the authoritative, already-permission-scoped list of
// Pages this Facebook user manages — unlike WhatsApp's Coexistence flow,
// there's no separate "hidden ID" debug_token step needed here: Instagram
// linking has no equivalent of a postMessage that might omit the id. The
// only real ambiguity is which of possibly-several managed Pages has an
// Instagram professional account linked at all.
//
// Same discipline as wabaConnectionService.discoverWabaAndPhoneNumber: only
// auto-resolves a single clear candidate, never guesses between two.
async function discoverInstagramAccount({ accessToken }) {
  const diagnostics = {};
  const pages = await instagramClient.listManagedPages(accessToken);
  diagnostics.pageCount = pages.length;

  if (pages.length === 0) {
    throw new Error('Meta returned no Facebook Pages this account manages — a Page is required to connect Instagram.');
  }

  const withInstagram = pages.filter((p) => p.instagram_business_account?.id);
  diagnostics.candidatePages = pages.map((p) => ({
    id: p.id,
    name: p.name,
    instagram_business_account_id: p.instagram_business_account?.id || null,
    instagram_username: p.instagram_business_account?.username || null,
  }));

  if (withInstagram.length === 0) {
    throw new Error('None of this account\'s Facebook Pages have a linked Instagram professional account yet — link one in Meta Business Suite first, then retry.');
  }
  if (withInstagram.length > 1) {
    diagnostics.reason = 'multiple_pages_with_instagram';
    return { needsManualResolution: true, reason: 'multiple_pages_with_instagram', diagnostics };
  }

  const page = withInstagram[0];
  return {
    pageId: page.id,
    pageAccessToken: page.access_token,
    instagramBusinessAccountId: page.instagram_business_account.id,
    igUsername: page.instagram_business_account.username || null,
    diagnostics,
  };
}

// The shared tail of a successful connect — subscribe the Page to Wasi's
// app, persist 'connected', bump client status. No phone registration, no
// template sync — neither has an Instagram Messaging API analog.
async function completeInstagramConnection(db, clientId, { pageId, pageAccessToken, instagramBusinessAccountId, igUsername }) {
  await instagramClient.subscribePageApp(pageId, pageAccessToken);

  const account = await instagramAccountsRepo.upsertForClient(clientId, {
    page_id: pageId,
    instagram_business_account_id: instagramBusinessAccountId,
    ig_username: igUsername || null,
    access_token_encrypted: encrypt(pageAccessToken),
    verified_at: new Date().toISOString(),
    status: 'connected',
  });

  const client = await clientsRepo.findById(db, clientId);
  if (client && client.status === 'payment_confirmed') {
    await clientsRepo.update(db, clientId, { status: 'active' });
  }

  return { account };
}

module.exports = { discoverInstagramAccount, completeInstagramConnection };
