// message_templates.status (002_platform_tables.js) only ever allowed
// ('approved', 'pending', 'rejected') — but Meta's real
// message_template_status_update webhook event vocabulary is wider than
// that (PAUSED, DISABLED, IN_APPEAL, PENDING_DELETION are all real values,
// not hypothetical). metaWebhook.js's handleTemplateStatusUpdate already
// lowercases whatever Meta sends and writes it straight into this column
// (`String(value.event || '').toLowerCase() || 'pending'`) — correct
// mapping, too narrow a target. The first time any client's template gets
// paused or disabled, that UPDATE violates this CHECK constraint and
// throws, which 500s the entire webhook delivery (metaWebhook.js's
// asyncHandler returns 500 on anyChangeFailed, by design, so Meta retries
// — but a constraint violation never stops being a constraint violation,
// so every retry fails identically until Meta gives up after 7 days).
// Widening the constraint is the whole fix; the application code that
// produces the value was already correct.
exports.up = (pgm) => {
  pgm.dropConstraint('message_templates', 'message_templates_status_check');
  pgm.addConstraint('message_templates', 'message_templates_status_check', {
    check: "status in ('approved', 'pending', 'rejected', 'paused', 'disabled', 'pending_deletion', 'in_appeal')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('message_templates', 'message_templates_status_check');
  pgm.addConstraint('message_templates', 'message_templates_status_check', {
    check: "status in ('approved', 'pending', 'rejected')",
  });
};
