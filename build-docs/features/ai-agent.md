# AI agent (Phase 1, end to end)

Full spec: `docs/ai-agent/SPEC.md`. This doc records what is built and the
decisions that depart from the spec.

## Purpose
Answer a customer's question from the client's own business information when
no flow or keyword rule handled the message, and hand over to a person when
it can't. Replaces silence (or a canned "*" greeting) with a real answer.

## Owner decisions (2026-11-23)
- Build continuously, unit by unit, each committed with tests.
- **Bring your own key (BYOK).** Each client adds their own Anthropic API key
  in Settings > AI Assistant. Only the platform key (`ANTHROPIC_API_KEY`,
  server env) may be used, and only for clients listed in
  `AI_PLATFORM_KEY_CLIENT_IDS` (the Wasi Demo Client for testing). Spec
  decision 4 answered: BYOA from the start.
- **Live only on the demo account with 9092766740** until the legal gate (P6:
  privacy policy, consent, lawyer) is cleared. Enforced in code:
  `AI_LIVE_ALLOWLIST` (`clientId:phone10` pairs). Every other client runs in
  `shadow` mode at most (reply generated and logged, never sent), and shadow
  for a real client also needs P6, so it stays off by default.
- Unit 0.5 (suspension send-block) not built; gate 1 refuses suspended clients.
- **No `temperature`** (spec 9.5 said 0.3): API version 2026-10-21 rejects
  sampling parameters on every model. Model is a setting, default
  `claude-haiku-4-5` (owner decision 22); Haiku 5.5 is a config change.
- No prompt caching (decision 19). `tokens_cached` still recorded.

## Architecture
- Migration 103: `ai_agents` (config, knowledge, meter, consent state,
  encrypted BYOK key, mode), `ai_agent_consent_events`,
  `ai_knowledge_sources`, `ai_replies`, `ai_gate_log`; `chats` gets
  `ai_muted*`, `ai_cooldown_until`, `ai_handover_reason/at`.
- `services/aiAgent/gates.js` - pure decision, gates 1-6 (section 7). No DB.
- `services/aiAgent/prompt.js` - 4 blocks (section 9), REFUSAL_TOKEN.
- `services/aiAgent/model.js` - `@anthropic-ai/sdk`, cost in paise, one
  retry on 429/5xx, 10 s timeout. Injectable for tests.
- `services/aiAgent/agentService.js` - the job handler: load, gates, prompt,
  model, post-checks (gates 7-8), send or shadow, handover, log.
- `aiAgentRunner` default instance wired to `isEligible` + `handleJob`.
- Routes `/api/ai-agent/*` (Owner/Admin for consent, key, enable; Admin/
  Manager for knowledge): settings, consent, key, knowledge CRUD, activity.
- Chat: `PATCH /api/chats/:id/ai-mute`; human reply clears handover.
- UI: Settings > AI Assistant; inbox assistant badge, needs-a-person,
  mute toggle, cooldown note.

## Impact map
- `metaWebhook.js` enqueue site (already wired, unit 0.4) - no change.
- `messagingService.sendChatMessage` - used as-is for AI sends (24h check,
  plan limit inherited). Must NOT write `last_agent_reply_at` (unit 0.2 rule).
- `routes/chats.js` human send - also clears `ai_handover_reason`.
- `chatsRepo.listMessages` - joins `ai_replies` to mark AI messages.
- Forwarding: AI outbound messages are ordinary outbound rows.

## Edge cases
- No key / invalid key: gate 1 fails, logged `no_api_key`; key validated on save.
- Model timeout/5xx: one retry, then handover `model_error`, no meter increment.
- Refusal token: handover message, 2 h cooldown, token never sent.
- Send fails after model success: `send_failed`, meter not incremented, logged.
- Window closed, human active, cap, rate (4/h/chat), schedule: silent + gate log.
- Key never returned by any API (only last 4 chars).
- Concurrency: one job per inbound message (unique index, unit 0.4).

## Acceptance criteria
1. Gate table in SPEC 16.1 passes as unit tests.
2. A question answerable from knowledge gets an answer via the real runner path.
3. Out-of-scope -> handover message, chat flagged, cooldown set, token never sent.
4. Human reply from the inbox silences the agent for 15 min and clears handover.
5. Cap stops replies and notifies once.
6. Activity numbers reconcile with `ai_replies`.
7. Client without the agent: no behaviour change (no job enqueued).
8. Non-allowlisted client/number never gets a sent reply (shadow at most).
9. BYOK key is encrypted at rest and never returned.

## Time-aware handover wording (2026-11-24, SPEC 15 / decision 16)
- `gates.handoverText(agent, now)`: if `handover_message` is the column default,
  inside staff hours -> "...they'll reply as quickly as they can."; outside ->
  "...back at <time> <today|tomorrow|on Monday>." (next `staff_hours` start, in
  the agent's timezone); no staff hours -> the static default.
- An edited message is always sent as written (save-time check still bans
  "shortly"/"soon").
- Used for the gate 8 handover and the Try-it panel.
