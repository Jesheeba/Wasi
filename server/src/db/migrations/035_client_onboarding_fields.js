// Expands client onboarding capture beyond name/email/password. All new
// columns are nullable — the admin panel's Create Client form still works
// with just the three original required fields; these are additional
// context a Sirah team member can fill in when known (business contact,
// the client's own developer for CRM/webhook integration work, and
// freeform integration/notes fields), not a stricter minimum bar.

exports.up = (pgm) => {
  pgm.addColumns('clients', {
    contact_person_name: { type: 'text' },
    contact_phone: { type: 'text' },
    company_details: { type: 'text' },
    developer_name: { type: 'text' },
    developer_phone: { type: 'text' },
    developer_email: { type: 'text' },
    integration_requirements: { type: 'text' },
    additional_notes: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('clients', [
    'contact_person_name',
    'contact_phone',
    'company_details',
    'developer_name',
    'developer_phone',
    'developer_email',
    'integration_requirements',
    'additional_notes',
  ]);
};
