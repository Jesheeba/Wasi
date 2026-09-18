// Bug found 18 Sep 2026, present since b9affd5 (15 Sep): a failed chat send's
// markFailed write was being rolled back by tenantContext.js's blanket
// `finalize(res.statusCode < 500)` rule, so meta_error_code (018) never
// actually reached disk for a send that failed through the tenant-scoped
// route. Fixing that (messagingService.js's sendChatMessage/retryMessage
// catch blocks now commit the failure write before throwing) makes
// meta_error_code reliable again, but meta_error_code alone isn't enough to
// diagnose a rejection — Meta's #200 alone covers several distinct causes
// separated only by error_subcode (see metaClient.js's graphFetch comment).
// This column stores that subcode alongside the code, same nullable/no-default
// shape as meta_error_code itself (018_super_admin_view_support.js) — not
// every failure reaches Meta at all, so not every failed row will have one.
exports.up = (pgm) => {
  pgm.addColumn('messages', {
    meta_error_subcode: { type: 'integer' },
  });
};

exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select(
    'select count(*)::int as count from messages where meta_error_subcode is not null'
  );
  if (count > 0) {
    throw new Error(`Cannot roll back 073_messages_error_subcode: ${count} messages row(s) have a real meta_error_subcode value that would be lost.`);
  }
  pgm.dropColumn('messages', 'meta_error_subcode');
};
