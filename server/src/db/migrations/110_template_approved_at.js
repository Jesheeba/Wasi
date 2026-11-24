// Records when a template was first approved by Meta, so sending can refuse a
// template Meta never approved (build-docs/features/template-approval-guard.md).
//
// Why "ever approved" and not just the current status: editing an approved
// template puts it back to 'pending' (messageTemplatesRepo.updateContent), but
// Meta keeps sending the old approved content while it re-reviews - that
// template must stay sendable. A trigger sets approved_at on every path that
// marks a row approved (sync, status webhook, admin approve, create), so no
// caller has to remember to.
//
// message_templates has a table-level wasi_app grant, so the new column needs
// no grant change.
exports.up = (pgm) => {
  pgm.addColumn('message_templates', { approved_at: { type: 'timestamptz' } });
  pgm.sql(`
    create function message_templates_stamp_approved_at() returns trigger as $$
    begin
      if new.status = 'approved' and new.approved_at is null then
        new.approved_at := now();
      end if;
      return new;
    end $$ language plpgsql;

    create trigger message_templates_approved_at
      before insert or update on message_templates
      for each row execute function message_templates_stamp_approved_at();

    -- Backfill: rows approved today, and any row that has ever been sent
    -- successfully (Meta only delivers approved templates).
    update message_templates t set approved_at = t.updated_at
    where t.approved_at is null and (
      t.status = 'approved'
      or exists (select 1 from messages m where m.client_id = t.client_id and m.direction = 'out'
                 and m.body = '[template: ' || t.name || ']' and m.status in ('sent', 'delivered', 'read'))
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop trigger if exists message_templates_approved_at on message_templates;
    drop function if exists message_templates_stamp_approved_at();
  `);
  pgm.dropColumn('message_templates', 'approved_at');
};
