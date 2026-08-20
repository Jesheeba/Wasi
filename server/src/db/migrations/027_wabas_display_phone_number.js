// metaClient.getPhoneNumberDetails already fetches display_phone_number
// (fields=display_phone_number,verified_name,quality_rating) at connect
// time, but onboarding.js only ever persisted verified_name and
// quality_rating — the real E.164 number was fetched and thrown away.
// Without it, nothing that needs the actual dialable number (the Settings >
// WhatsApp > Profile preview, the Message Link tab's wa.me link) has real
// data to show, only phone_number_id (Meta's internal identifier, not a
// phone number a human can read or dial).
exports.up = (pgm) => {
  pgm.addColumns('wabas', {
    display_phone_number: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('wabas', ['display_phone_number']);
};
