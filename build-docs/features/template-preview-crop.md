# Template preview shows the whole image

## Purpose
The Create Template preview cropped a tall image header to a 140px strip
(`object-fit: cover`), so authors could not see what they were submitting.

## Change
`.template-preview-media-thumb`: `object-fit: contain`, natural height up to
320px. Carousel card thumbs keep the fixed cropped look. The IMAGE file hint
now says WhatsApp crops tall images in the chat bubble and that ~1.91:1
(e.g. 800x418) shows in full.

## Impact map
`index.css`, `app.js` (`MEDIA_HEADER_HINT`). Same class is used by the video
preview; contain is correct there too.

## Acceptance criteria
AC13 (CSS) + visual check with a 1069x1471 poster: rendered 173x238, uncropped.
