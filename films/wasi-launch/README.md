# Wasi launch film (90 seconds): "Your business on WhatsApp, ready for AI agents"

1920x1080, 30 fps, H.264 + AAC, mix at -14 LUFS. Exactly 90.0 s.

## Build

```bash
./build.sh            # full build: ElevenLabs VO -> timing -> score -> sfx -> mix -> frames -> mp4
./build.sh --preview  # no VO: estimated timing, music + sfx only -> *_PREVIEW_no-voice.mp4
node scripts/generate-vo.js --check   # verify the ElevenLabs key (spends ~3 characters)
node scripts/stills.js <dir> 12 40.5  # screenshot chosen instants for review
```

- **Voice:** ElevenLabs voice `J9gbaR3XWZq9razzBxca`, model `eleven_multilingual_v2`, generated as ONE continuous take of the whole script via `/with-timestamps`, so the read is a single performance. `build-timing.js` cuts it only in the natural pause between scenes; inside a scene the take is untouched. The take is cached by a hash of script + settings, so a rebuild spends no credits. Key: `ELEVENLABS_API_KEY`, else `eleven_labs` in `server/.env`. Speed: `VO_SPEED=1.1 node scripts/generate-vo.js --force` (default 1.08, range 0.7-1.2).
- **Timing:** every beat is keyed to the exact word the voice is on (`wt(id, word)` in `timeline.js`), from ElevenLabs' per-character timings, so a new read re-times the picture by itself. Spare time is given to each scene as a hold after its voice; the film always lands on 90.0 s.
- **Picture:** `scenes/film.html` loads the repo's real `breakpoints.css` and `design-system.css`. A dark, aurora-lit stage with light product UI: a realistic WhatsApp chat on a phone (customer view, original doodle wallpaper, read ticks, typing indicator, Tamil + English), the AI assistant panel, the inbox, an agent console with MCP tool calls, a guardrails pipeline, campaign and flow-builder windows. Brand mark and colours unchanged; Inter for UI, Poppins for headlines, JetBrains Mono for code.
- **Sound:** original score and effects synthesized in `make-music.js` / `make-sfx.js`; effects come from `window.CUES`, which the timeline declares. Music sits about 16 dB under the voice: low base level, a cut in the 2-4 kHz speech band, and sidechain ducking (the mix script prints the measured gap).

## Script

| # | Scene | Line |
|---|---|---|
| 1 | Hook | AI agents can now answer questions, follow up, and close the sale. / But your customers aren't waiting in a chat box on your website. They're on WhatsApp. |
| 2 | Reveal | So we built a safe home for AI agents on WhatsApp. Meet Wasi. |
| 3 | Built-in assistant | Switch on Wasi's AI assistant, and it answers from your own business knowledge. Fees, timings, orders. In seconds, at any hour, in your customer's own language. |
| 4 | Handover | When a question goes beyond what it knows, it doesn't guess. It hands the chat to your team, with the full context. / And the moment a teammate steps in, the assistant steps back. |
| 5 | Bring your own agent | Building your own agents? Plug them straight in. / Through MCP, our API, n8n or Zapier, any agent can send messages, read conversations and use your templates, on your own WhatsApp number. |
| 6 | Guardrails | And every send passes the same guardrails. Approved templates only. Opted-out customers skipped. All on Meta's official Cloud API. |
| 7 | Shared inbox | Your team sees it all in one shared inbox. Every AI reply, every handover, and what each answer cost. |
| 8 | Campaigns + flows | Then go further. Launch campaigns, build visual flows, and follow every message from sent to read. |
| 9 | Recap | Your agents. Your team. Your customers. All in one place. |
| 10 | Close | Wasi. Your business on WhatsApp, ready for AI agents. / Start today at wasi.sirahagents.com |

Positioning follows the research in the keynote deck: no "first" or "only" claims (ASCI substantiation), WhatsApp used only descriptively and never as "One WhatsApp" (Meta brand rules), AI framed as a feature of a messaging product (Meta terms s.4.7). **The film shows the AI assistant answering customers; hold public release until the assistant is enabled for clients.** Product scenes carry an "illustrative data" footnote; every name, number and count on screen is made up. The v1 cut (general CRM script) is in git history at `10d0461`.
