// PLAN.md item 9 — translates a validated { combinator, conditions }
// filter_json (utils/validate.js's segmentFilterSchema) into a
// parameterized SQL WHERE fragment for use against `contacts` (bare table
// name — every condition references `contacts.id` directly, so the caller
// must not alias the table) plus its matching bound-parameter array.
//
// NEVER string-concatenates a user-supplied VALUE into the SQL text
// itself — every value (a tag id, an attribute id, a comparison value) is
// a bound parameter, always produced via bind() below. The only literal
// SQL that ever appears in the returned fragment is developer-authored:
// fixed column/table names, and comparison operators chosen from this
// file's own fixed lookup objects (never the raw condition.op string
// itself dropped into the query text) — so this holds even though op
// comes from parsed user JSON.
//
// attributeTypesById: Map<attributeId, 'text'|'number'|'date'|'boolean'> —
// looked up by the caller with a single query (routes/contactSegments.js's
// attributeTypesFor), not per-condition here, since a condition's op
// validity and cast behavior both depend on the attribute's REAL declared
// type — the client-submitted filter_json cannot be trusted to state it
// accurately (segmentConditionSchema only validates shape, not that the
// attributeId's actual type matches how it's being compared).

class UnknownAttributeError extends Error {}
class InvalidConditionError extends Error {}

// Shared by both callers that run a compiled filter against the real
// contacts table (routes/contactSegments.js's /preview, routes/
// broadcasts.js's segment-audience resolution) via SET LOCAL
// statement_timeout — see either call site's own comment for the full
// reasoning. One constant so the two stay in sync, not two magic numbers.
const SEGMENT_QUERY_TIMEOUT_MS = 5000;

const NUMERIC_OPS = { eq: '=', gt: '>', lt: '<' };
const DATE_OPS = { eq: '=', gt: '>', lt: '<' };

function compileCondition(condition, { attributeTypesById, bind }) {
  if (condition.field === 'tag') {
    // item 8's contact_tags is the authoritative, complete tag source for a
    // segment condition — not contacts.tag_id directly (that column stays
    // the untouched, separate "primary tag" used by the pre-existing
    // tag-based broadcast audience path, unrelated to this one).
    return `exists (select 1 from contact_tags ct where ct.contact_id = contacts.id and ct.tag_id = ${bind(condition.value)})`;
  }

  if (condition.field === 'opt_in_status') {
    return `contacts.opt_in_status = ${bind(condition.value)}`;
  }

  if (condition.field === 'attribute') {
    const type = attributeTypesById.get(condition.attributeId);
    if (!type) throw new UnknownAttributeError(`Unknown attribute id "${condition.attributeId}".`);

    if (type === 'number') {
      const cmp = NUMERIC_OPS[condition.op];
      if (!cmp) throw new InvalidConditionError(`op "${condition.op}" is not valid for a number attribute (use eq, gt, or lt).`);
      // Defensive regex guard before the cast (item 7/9's agreed casting
      // strategy) — a row that somehow fails it (bad legacy data, or one
      // written before write-time validation existed) is excluded from the
      // comparison rather than throwing the whole query.
      return `exists (
        select 1 from contact_attribute_values v
        where v.contact_id = contacts.id and v.attribute_id = ${bind(condition.attributeId)}
          and v.value ~ '^-?\\d+(\\.\\d+)?$'
          and v.value::numeric ${cmp} ${bind(condition.value)}::numeric
      )`;
    }

    if (type === 'date') {
      const cmp = DATE_OPS[condition.op];
      if (!cmp) throw new InvalidConditionError(`op "${condition.op}" is not valid for a date attribute (use eq, gt, or lt).`);
      return `exists (
        select 1 from contact_attribute_values v
        where v.contact_id = contacts.id and v.attribute_id = ${bind(condition.attributeId)}
          and v.value ~ '^\\d{4}-\\d{2}-\\d{2}$'
          and v.value::date ${cmp} ${bind(condition.value)}::date
      )`;
    }

    if (type === 'boolean') {
      if (condition.op !== 'eq') throw new InvalidConditionError(`op "${condition.op}" is not valid for a boolean attribute — only "eq".`);
      return `exists (
        select 1 from contact_attribute_values v
        where v.contact_id = contacts.id and v.attribute_id = ${bind(condition.attributeId)}
          and v.value = ${bind(condition.value)}
      )`;
    }

    // text
    if (condition.op === 'eq') {
      return `exists (
        select 1 from contact_attribute_values v
        where v.contact_id = contacts.id and v.attribute_id = ${bind(condition.attributeId)}
          and v.value = ${bind(condition.value)}
      )`;
    }
    if (condition.op === 'contains') {
      // Wildcard-wrapping happens in SQL via ||, not by building the '%...%'
      // string in JS and concatenating it into the query text — the raw
      // search term stays a plain bound parameter either way. A literal
      // '%'/'_' inside the user's own search term acts as an ILIKE wildcard
      // (a minor correctness quirk, not a security issue) — not escaped,
      // out of scope for this pass.
      return `exists (
        select 1 from contact_attribute_values v
        where v.contact_id = contacts.id and v.attribute_id = ${bind(condition.attributeId)}
          and v.value ilike '%' || ${bind(condition.value)} || '%'
      )`;
    }
    throw new InvalidConditionError(`op "${condition.op}" is not valid for a text attribute (use eq or contains).`);
  }

  throw new InvalidConditionError(`Unknown condition field "${condition.field}".`);
}

// paramOffset: how many params the CALLER already bound before this
// fragment (e.g. 1 if client_id is already $1 in the caller's own query) —
// this fragment's own placeholders continue from there ($2, $3, ...), and
// the returned `params` array is meant to be spread AFTER the caller's own
// params in the final query's parameter list.
function compileFilter(filterJson, { attributeTypesById = new Map(), paramOffset = 0 } = {}) {
  const params = [];
  function bind(value) {
    params.push(value);
    return `$${paramOffset + params.length}`;
  }

  const clauses = filterJson.conditions.map((condition) => compileCondition(condition, { attributeTypesById, bind }));
  const joiner = filterJson.combinator === 'OR' ? ' or ' : ' and ';
  // segmentFilterSchema enforces conditions.length >= 1, so clauses is
  // never actually empty in practice — this fallback only guards a caller
  // that bypasses schema validation and calls compileFilter directly.
  const sql = clauses.length ? `(${clauses.join(joiner)})` : (filterJson.combinator === 'OR' ? 'false' : 'true');
  return { sql, params };
}

module.exports = { compileFilter, UnknownAttributeError, InvalidConditionError, SEGMENT_QUERY_TIMEOUT_MS };
