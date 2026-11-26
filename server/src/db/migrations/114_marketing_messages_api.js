// Marketing Messages API for WhatsApp (build-docs/features/marketing-messages-api.md).
// wabas.mm_api_enabled: admin switch (owner, 2026-11-26: off by default,
// turned on per client). mm_api_status/mm_api_checked_at: Meta's
// marketing_messages_onboarding_status, last read.
// messages.send_route: null = Cloud API /messages; 'mm_api' = sent to
// /marketing_messages and Meta billed it as marketing_lite; 'mm_api_fallback'
// = sent to /marketing_messages but Meta delivered it via Cloud API.
//
// No grant: wabas is only read through the privileged pool (wabasRepo.js);
// messages has a table-level wasi_app grant. send_route is excluded from
// webhook forwarding in metaWebhook.js.

exports.up = (pgm) => {
  pgm.addColumns('wabas', {
    mm_api_enabled: { type: 'boolean', notNull: true, default: false },
    mm_api_status: { type: 'text' },
    mm_api_checked_at: { type: 'timestamptz' },
  });
  pgm.addColumns('messages', {
    send_route: { type: 'text', check: "send_route in ('mm_api', 'mm_api_fallback')" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('messages', ['send_route']);
  pgm.dropColumns('wabas', ['mm_api_enabled', 'mm_api_status', 'mm_api_checked_at']);
};
