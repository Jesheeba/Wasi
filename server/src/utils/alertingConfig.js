// Single source of truth for "is alerting/email configured" — read by
// index.js's startup warning and the admin Health Monitor's "Alerts are not
// configured" banner (GET /api/admin/alerting-status, admin/app.js), so the
// two can never disagree about what counts as configured. Pure
// process.env reads, no DB, safe to call from anywhere including before the
// DB pool exists.
function getAlertingConfigStatus() {
  return {
    resendConfigured: Boolean(process.env.RESEND_API_KEY),
    emailConfigured: Boolean(process.env.ALERT_EMAIL_TO),
    whatsappConfigured: Boolean(process.env.ALERT_WHATSAPP_TO && process.env.ALERT_WABA_ID),
  };
}

module.exports = { getAlertingConfigStatus };
