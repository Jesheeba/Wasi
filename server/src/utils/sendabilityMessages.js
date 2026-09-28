// Plain-English sendability messaging — shared, dual-export module (same
// pattern as templateParams.js/consentStatement.js: served raw via a static
// route so the client banner, the chat-send error surface, and admin's
// client-detail view all read the exact same wording from one place,
// never a hand-duplicated copy that drifts).
//
// Built for the "why can't my client send" gap: today the raw data already
// exists on the wabas row (sendable/sendable_reason/health_status/
// probe_error_code — see migrations 074-076_wabas_*.js and
// sendabilityMonitorRunner.js's computeSendableVerdict) but nothing ever
// translated it into something a client — or an admin glancing at their
// account — can read without knowing what "#141006" means.
//
// Every code below is a REAL Meta error code this app has actually seen or
// that Meta documents for this exact failure class (141006 payment method,
// 141010 business verification, 200 permission/credit-line) — same
// discipline as this codebase's other content heuristics (see CLAUDE.md's
// template category/content-mismatch entry): known codes get real, specific
// wording; anything else gets an honest generic message plus the raw code,
// never a blank or silently-dropped banner.
const KNOWN_CODES = {
  141006: {
    headline: "Your account can't send messages until a payment method is added.",
    action: 'Add a payment method in WhatsApp Manager to restore sending.',
    actionKey: 'add_payment_method',
  },
  141010: {
    headline: "Your account can't send messages until your business is verified with Meta.",
    action: 'Start business verification in Meta Business Manager to restore sending.',
    actionKey: 'start_verification',
  },
  200: {
    headline: "Your account doesn't currently have permission to send messages.",
    action: "This needs to be fixed on our side — contact us, this isn't something you can resolve yourself.",
    actionKey: 'contact_support',
  },
};

function genericUnknown(code) {
  return {
    headline: "There's a problem with your WhatsApp account that's stopping messages from sending.",
    action: 'Contact support and mention the code below.',
    actionKey: 'contact_support',
    code: code ?? null,
  };
}

// Given a single Meta error code (from a health_status entity, the
// sendability probe, or a live send failure), returns a plain-English
// {headline, action, actionKey, code} — always something usable, never
// null, so no caller has to invent its own fallback wording.
function describeErrorCode(code) {
  const numeric = typeof code === 'number' ? code : (code != null && code !== '' ? Number(code) : null);
  const known = numeric != null && !Number.isNaN(numeric) ? KNOWN_CODES[numeric] : null;
  if (known) return { ...known, code: numeric };
  return genericUnknown(Number.isNaN(numeric) ? code : numeric);
}

// health_status shape: { entities: [{ entity_type, can_send_message:
// 'AVAILABLE'|'LIMITED'|'BLOCKED', errors: [{ error_code, error_description }] }] }
// (see migration 074_wabas_sendability.js's header comment). Returns the
// single worst entity found, BLOCKED outranking LIMITED, or null if every
// entity is AVAILABLE (or health_status itself is missing/malformed).
function findWorstHealthEntity(healthStatus) {
  const entities = Array.isArray(healthStatus?.entities) ? healthStatus.entities : [];
  const blocked = entities.find((e) => e?.can_send_message === 'BLOCKED');
  if (blocked) return { severity: 'blocked', entity: blocked };
  const limited = entities.find((e) => e?.can_send_message === 'LIMITED');
  if (limited) return { severity: 'limited', entity: limited };
  return null;
}

// The single entry point: given a wabas row, decides whether a persistent
// banner should show at all and, if so, its severity and exact wording.
// Returns null when nothing needs to be shown.
//
// Three severities, deliberately NOT conflated (a client panicking over a
// soft cap, or shrugging off a real outage, are both real failure modes of
// getting this wrong):
//   - 'blocked'  — sendable === false, or a health_status entity is BLOCKED.
//                  The account genuinely cannot send right now.
//   - 'limited'  — a health_status entity is LIMITED (and nothing is
//                  BLOCKED). Degraded, not broken.
//   - 'capped'   — messaging_tier is TIER_250, the tier Meta caps an
//                  unverified/unapproved display name to. Sending still
//                  works; this is a softer, informational notice, shown
//                  even when neither of the above conditions is true.
//
// sendable === null (never successfully checked) is deliberately NOT a
// banner condition — sendabilityMonitorRunner.js's own discipline treats
// "we couldn't check" as distinct from "we checked and it's a problem," and
// a brand-new/never-probed account showing a scary banner on day one would
// be a false alarm, not a real finding.
function describeSendability(waba) {
  if (!waba) return null;

  const worstHealth = findWorstHealthEntity(waba.health_status);

  if (waba.sendable === false || worstHealth?.severity === 'blocked') {
    const code = worstHealth?.entity?.errors?.[0]?.error_code ?? waba.probe_error_code ?? null;
    const info = describeErrorCode(code);
    return {
      severity: 'blocked',
      headline: info.headline,
      action: info.action,
      actionKey: info.actionKey,
      code: info.code,
      rawReason: waba.sendable_reason || worstHealth?.entity?.errors?.[0]?.error_description || null,
    };
  }

  if (worstHealth?.severity === 'limited') {
    const code = worstHealth.entity?.errors?.[0]?.error_code ?? null;
    return {
      severity: 'limited',
      headline: 'Your WhatsApp account is working, but sending is currently limited.',
      action: 'This usually clears on its own — contact us if it continues for more than a day or two.',
      actionKey: 'contact_support',
      code,
      rawReason: worstHealth.entity?.errors?.[0]?.error_description || null,
    };
  }

  if (waba.messaging_tier === 'TIER_250') {
    return {
      severity: 'capped',
      headline: 'Sending works, but your account is capped at 250 unique customers every 24 hours.',
      action: "This is usually because your display name isn't approved yet — approving it (or building a track record with Meta) raises this limit over time.",
      actionKey: 'contact_support',
      code: null,
      rawReason: null,
    };
  }

  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { describeErrorCode, describeSendability, findWorstHealthEntity, KNOWN_CODES };
} else if (typeof window !== 'undefined') {
  window.sendabilityMessages = { describeErrorCode, describeSendability, findWorstHealthEntity, KNOWN_CODES };
}
