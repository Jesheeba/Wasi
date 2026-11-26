// Marketing Messages API activity sharing (build-docs/features/marketing-messages-api.md,
// owner 2026-11-26): the client's choice whether Meta may use delivery, read
// and click data from their Marketing messages to optimise delivery. Sent as
// message_activity_sharing on every /marketing_messages call. Default false
// (don't share) until the privacy policy covers it. Who changed it and when
// is in audit_log (mm_activity_sharing_on / _off).
//
// No grant: wabas is only read through the privileged pool (wabasRepo.js).

exports.up = (pgm) => {
  pgm.addColumns('wabas', {
    mm_activity_sharing: { type: 'boolean', notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('wabas', ['mm_activity_sharing']);
};
