// Custom forms (build-docs/features/custom-forms.md): whatsapp_flows.kind
// gains 'custom' (a form built question by question). Forms keep their
// questions in config.fields; no new columns, so no grant changes.
const KINDS = "'lead', 'booking', 'survey', 'booking_live', 'onboarding'";

exports.up = (pgm) => {
  pgm.dropConstraint('whatsapp_flows', 'whatsapp_flows_kind_check');
  pgm.addConstraint('whatsapp_flows', 'whatsapp_flows_kind_check', { check: `kind in (${KINDS}, 'custom')` });
};

exports.down = (pgm) => {
  pgm.sql(`do $$ begin
    if exists (select 1 from whatsapp_flows where kind = 'custom') then
      raise exception 'Cannot roll back 108: custom forms exist';
    end if; end $$;`);
  pgm.dropConstraint('whatsapp_flows', 'whatsapp_flows_kind_check');
  pgm.addConstraint('whatsapp_flows', 'whatsapp_flows_kind_check', { check: `kind in (${KINDS})` });
};
