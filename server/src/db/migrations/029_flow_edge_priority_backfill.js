// Every flow_edges row created through the editor so far has priority = 0
// (flowEdgesRepo.create defaulted it via coalesce($7, 0), and nothing in
// app.js's Add Branch form ever sent a value — see app.js's Add Branch
// submit handler). Ordering has worked by accident: listForNode/listByFlowId
// break priority ties on created_at, which happens to match authoring
// order today. That's fragile — priority is the column the engine and the
// editor are both supposed to treat as the explicit, authoritative order,
// not created_at. This backfills every existing edge's priority to match
// what its effective (accidental) order already is, so it stops being an
// implicit created_at side-effect and becomes a real, editable value —
// paired with flowEdgesRepo.create now auto-assigning a real next-priority
// value for new edges instead of always defaulting to 0 (see that file).
// Purely a data fix: does not change any flow's actual runtime ordering,
// since the backfilled values reproduce today's created_at-based order
// exactly.
exports.up = (pgm) => {
  pgm.sql(`
    with ranked as (
      select id,
             row_number() over (
               partition by from_node_id
               order by (condition_type = 'default') asc, created_at asc
             ) - 1 as new_priority
      from flow_edges
    )
    update flow_edges
    set priority = ranked.new_priority
    from ranked
    where flow_edges.id = ranked.id
  `);
};

exports.down = () => {
  // Not reversible in any meaningful sense — the pre-migration state (every
  // priority = 0) is exactly what made ordering implicit and fragile in the
  // first place. Nothing downstream depends on rolling this back.
};
