# Hub API: templates with an image/video/document header

## Purpose
`POST /api/v1/templates` only took JSON, so an IMAGE/VIDEO/DOCUMENT header
always failed at Meta (no sample handle). Found 2026-11-24 when a client's poster template could only be submitted through the CRM UI.

## Architecture
- Same route, now also `multipart/form-data`: file in `file`, template JSON in
  `data` (same shape as the CRM's own create route). Or plain JSON with
  `headerMediaUrl` (public https; SSRF guard `assertPublicHttpsUrl`).
- `mediaHeaderService` gains `checkHeaderFile`, `uploadTemplateHeaderMedia`
  (Resumable Upload handle + Media API id) and `fetchPublicMediaFile`. The CRM
  create/edit routes and `resolveMediaIdFromUrl` now use them (one copy).
- Success: Meta gets the handle; `meta_template_id` is stored; the media id is
  seeded as the template's default `template_media_cache` row (sendable once
  approved). Also added: the (name, language) duplicate check the CRM route had.

## Impact map
- `routes/apiV1Templates.js`, `routes/templates.js` (refactor only),
  `services/mediaHeaderService.js`, `middleware/apiV1ErrorHandler.js`
  (MulterError -> 400 `invalid_upload`), API docs (guide + admin API Guide).
- Risk: the shared upload helper is now on the CRM create/edit path too;
  covered by templateEdit/templateMediaAssets/carousel tests.

## Edge cases
No file / both file and URL / file with non-media header / wrong type or size /
wrong field name / WhatsApp not connected (409) / duplicate name (409) / Meta
upload failure (502 with Meta's text). Carousel via API: still not supported.

## Acceptance criteria
AC1-AC8 in `server/test/apiV1TemplateMediaAndMessagingLimit.test.js`.
