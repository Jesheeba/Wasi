# Contacts: bulk tagging

## Purpose
Tagging was one contact at a time (contact detail panel). A client with
hundreds of contacts had no way to tag a group (e.g. everyone from one event).

## Architecture
- UI: the Contacts selection bar (row checkboxes, select-all, "select all N
  matching") gains a **Tags** button. `#modal-bulk-tags`: pick a tag, or type a
  new name (Owner/Admin/Manager only, since `POST /api/tags` is
  Admin/Manager), then **Add tag** or **Remove tag**. Selection is kept after,
  so a second tag can follow straight away.
- API: `POST /api/contacts/bulk-tags` `{contactIds (1-20000 uuids), tagId,
  action: 'add'|'remove'}` -> `{action, tag, selected, changed}`. Roles:
  Admin/Manager/Agent (same as per-contact tag routes).
- Repo: `contactTagsRepo.addMany` (one `insert ... select from contacts`,
  filtered by client, `on conflict do nothing`), `removeMany` (deletes the
  `contact_tags` row AND clears `contacts.tag_id` when it is that tag),
  `tagIdsByContact`.
- `GET /api/contacts` now returns `tag_ids` per contact; the Tags column,
  tag filter and search use all of a contact's tags, not just the primary one.

## Impact map
- `contacts.tag_id` (primary tag): add never touches it; remove clears it when
  it matches. Tag-targeted broadcasts read `tag_id OR contact_tags`, so a
  removed tag stops matching both ways.
- Hub API `GET /api/v1/contacts`: unchanged (uses `contactsRepo.list`, which
  was not modified).
- Segments/analytics read `contact_tags`: bulk add is visible to them at once.

## Edge cases
- Foreign or deleted contact ids: silently skipped (join on the client's own
  contacts), counted as unchanged.
- Foreign/unknown tag: 404. Duplicate ids: deduped. Empty list / bad action: 400.
- Already-tagged / not-tagged contacts: no-op, reported in the toast.
- Typed name matching an existing tag (case-insensitive) reuses it; Remove with
  an unknown typed name is refused client-side.

## Acceptance criteria
1. Add tags every selected contact; repeat is idempotent; counts are honest.
2. Contacts list returns and shows every tag.
3. Remove detaches the tag and clears it as primary.
4. Validation errors 400/404.
5. No cross-tenant tagging.
6. Unauthenticated 401.
