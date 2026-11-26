# Wasi launch film (90 seconds)

1920x1080, 30 fps, H.264 + AAC, mix at -14 LUFS. Exactly 90.0 s.

## Build

```bash
./build.sh            # full build: ElevenLabs VO -> timing -> score -> sfx -> mix -> frames -> mp4
./build.sh --preview  # no VO: estimated timing, music + sfx only -> *_PREVIEW_no-voice.mp4
node scripts/generate-vo.js --check   # verify the ElevenLabs key + voice, spends no credits
node scripts/stills.js <dir> 12 40.5  # screenshot chosen instants for review
```

- **Voice:** ElevenLabs voice `J9gbaR3XWZq9razzBxca`, model `eleven_multilingual_v2`, one take per line joined with `previous_text`/`next_text`. Key: `ELEVENLABS_API_KEY`, else `eleven_labs` in `server/.env`. Speed: `VO_SPEED=1.05 node scripts/generate-vo.js --force` (range 0.7-1.2).
- **Timing:** `build-timing.js` measures each VO clip and lets every scene absorb its share of the remaining time, so the film always lands on 90.0 s. Every animation beat is tied to a VO line, so a new read re-times the whole picture by itself.
- **Picture:** `scenes/film.html` loads the repo's real `breakpoints.css` (tokens) and `design-system.css` (components). On screen: `wa-bubble`/`wa-preview`, `badge-*`, `alert-success`, `toast`, `tabs`, `stat-tile`, `list-row`, `avatar-initials`, `connect-steps`, `option-card`, `chip-btn`, `wasi-toggle`, `nav-group-label`, `side-note`, `spinner`, plus the campaign wizard stepper from `index.css`. Brand mark paths and colours are unchanged from `index.html`; Inter for UI, Poppins for the wordmark and headlines; Lucide icons at stroke 1.75.
- **Sound:** original score and sound effects synthesized in `make-music.js` / `make-sfx.js` (no sample library on this machine). Effects come from `window.CUES`, which the timeline declares, so sound and picture stay in sync. Music is sidechain-ducked under the voice.

## Script

| # | Scene | Line |
|---|---|---|
| 1 | Hook | Right now, your customers are on WhatsApp. Asking about prices, orders, and appointments. / Every message is a sale waiting to happen. But on one busy phone, most of them just wait. |
| 2 | Reveal | Today, that changes. Meet Wasi. |
| 3 | Connect | Connect your own WhatsApp number in minutes, on Meta's official Cloud API. No paperwork. No middleman. |
| 4 | Shared inbox | Your whole team answers from one shared inbox. Assign a chat, leave a private note, and reply in seconds. |
| 5 | Campaigns | Launch a campaign to your whole list in five simple steps. Then see exactly who it reached, who read it, and who didn't. |
| 6 | Templates | Write templates with live checks as you type, and preview the exact message your customer will see. |
| 7 | Automation | When the day ends, automation takes over. Visual flows greet, ask questions, and capture answers. No code needed. |
| 8 | Integrations | And Wasi plugs into the tools you already run, through a developer API, webhooks, and Zapier. |
| 9 | Recap | Every conversation. Every campaign. Every customer. One place. |
| 10 | Close | Wasi. Turn conversations into customers. / Get started today at wasi.sirahagents.com |

Only features marked live in `CLAUDE.md` are shown. Not shown on purpose: the AI assistant (not yet enabled for clients), WhatsApp Forms and WooCommerce (no live Meta/store check yet), and any pricing. Product scenes carry an "illustrative data" footnote; every name, number and count on screen is made up.
