# Wasi launch film (90 seconds): "Your business on WhatsApp, ready for AI agents"

1920x1080, 30 fps, H.264 + AAC, mix at -14 LUFS. Exactly 90.0 s.

## Build

```bash
./build.sh            # full build: ElevenLabs VO -> timing -> score -> sfx -> mix -> frames -> mp4
./build.sh --preview  # no VO: estimated timing, music + sfx only -> *_PREVIEW_no-voice.mp4
node scripts/generate-vo.js --check   # verify the ElevenLabs key (spends ~3 characters)
node scripts/stills.js <dir> 12 40.5  # screenshot chosen instants for review
node scripts/sheet.js <dir> 3         # contact sheet of those stills
```

- **Voice:** ElevenLabs voice `J9gbaR3XWZq9razzBxca`, model `eleven_multilingual_v2`, generated as ONE continuous take of the whole script via `/with-timestamps`, so the read is a single performance. `build-timing.js` cuts it only in the natural pause between scenes; inside a scene the take is untouched. The take is cached by a hash of script + settings, so a rebuild spends no credits. Key: `ELEVENLABS_API_KEY`, else `eleven_labs` in `server/.env`. Speed: `VO_SPEED=1.1 node scripts/generate-vo.js --force` (default 1.08, range 0.7-1.2).
- **Timing:** every beat is keyed to the exact word the voice is on (`wt(id, word)` in `timeline.js`), from ElevenLabs' per-character timings, so a new read re-times the picture by itself. Spare time is given to each scene as a hold after its voice; the film always lands on 90.0 s.
- **Picture:** a light stage in the app's own palette. Product scenes are built from the product itself. `scripts/extract-app-ui.js` copies the live sidebar from the root `index.html`, and `index.css` without its font import, into `scenes/`. `film.html` loads them with the real `breakpoints.css` and `design-system.css`, so the inbox, AI Assistant settings, badges, stat tiles and chat bubbles use the app's real classes and styles. Motion is deliberately restrained: masked word reveals, slow camera pushes, one easing family and fade-through-background transitions, with no particles, glows or flashes. Fonts (Inter, Poppins, JetBrains Mono and Noto Sans Tamil, all OFL) and Lucide icons are stored in `scenes/`, so a render never needs the network.
- **Music:** an instrumental from ElevenLabs Music (`music_v1` with a composition plan), made by `make-music.js`. Its sections are sized to the scenes, so the lift lands on "Meet Wasi" and the resolve on the end card. It is cached by a hash of the plan; a new generation costs about 1,100 credits. Check your ElevenLabs plan's commercial-use terms before publishing.
- **Mix:** the music is a steady bed with no sidechain pumping. It sits about 12 dB under the voice while it speaks and rises +6 dB only before the first line and after the last. `assemble-audio.js` measures and prints that gap over the spoken parts only. Effects are a few soft UI sounds from `window.CUES`. The master is -14 LUFS / -1 dBTP. To change the bed level, run `MUSIC_GAIN=0.15 node scripts/assemble-audio.js`.

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

Positioning follows the research in the keynote deck: no "first" or "only" claims (ASCI substantiation), WhatsApp used only descriptively and never as "One WhatsApp" (Meta brand rules), AI framed as a feature of a messaging product (Meta terms s.4.7). **The film shows the AI assistant answering customers; hold public release until the assistant is enabled for clients.** The end card says "Product screens shown with sample data"; every name, number and count on screen is made up. Earlier cuts are in git history: v1 (general CRM script) at `10d0461` and v2 (dark stage) at `ea2e9d3`.
