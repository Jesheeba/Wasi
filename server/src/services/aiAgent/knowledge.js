// Knowledge intake (SPEC section 8). Phase 1 inlines the whole compiled
// knowledge in the prompt (no retrieval), capped at 2,500 tokens per client.
const TOKEN_BUDGET = 2500;

// Rough count, used only when no API key is available to count exactly
// (decision 20 prefers the API's count). Conservative for Tamil.
const estimateTokens = (text) => Math.ceil(String(text || '').length / 3.5);

function compile(sources) {
  const active = sources.filter((s) => s.is_active).sort((a, b) => a.sort_order - b.sort_order);
  const parts = [];
  const qa = active.filter((s) => s.kind === 'qa');
  if (qa.length) {
    parts.push('## Common questions\n' + qa.map((s) => `**Q: ${s.question}**\nA: ${s.answer}`).join('\n\n'));
  }
  for (const doc of active.filter((s) => s.kind !== 'qa')) parts.push(`## ${doc.title || 'Information'}\n${doc.body}`);
  return { md: parts.join('\n\n'), sourceIds: active.map((s) => s.id) };
}

// Phase 1 returns everything and ignores the message; retrieval can replace
// this later without anything else in the pipeline changing (SPEC 8.1).
function getKnowledgeFor(agent) {
  return agent.knowledge_md;
}

// Route 2 (SPEC 8.2): draft Q&A pairs from the client's own last 60 days.
// Crude on purpose: normalised text, top repeated questions with the reply
// staff actually gave next. It only has to beat an empty box.
const STOPWORDS = new Set(['hi', 'hello', 'sir', 'madam', 'mam', 'pls', 'please', 'the', 'a', 'an', 'is', 'what', 'ok', 'okay', 'thanks', 'thank', 'you']);
function normalise(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter((w) => w && !STOPWORDS.has(w)).join(' ');
}
// rows: [{ chat_id, direction, body, sent_at }] ordered by chat, then time.
function suggestFromHistory(rows, { minRepeats = 3, limit = 20 } = {}) {
  const groups = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const m = rows[i];
    if (m.direction !== 'in') continue;
    const key = normalise(m.body);
    if (key.split(' ').length < 2) continue; // "hi", "ok": not a question
    const next = rows.slice(i + 1).find((r) => r.chat_id === m.chat_id && r.direction === 'out' && r.body);
    if (!groups.has(key)) groups.set(key, { phrasings: new Map(), answers: new Map(), count: 0 });
    const g = groups.get(key);
    g.count += 1;
    g.phrasings.set(m.body.trim(), (g.phrasings.get(m.body.trim()) || 0) + 1);
    if (next && next.chat_id === m.chat_id) g.answers.set(next.body.trim(), (g.answers.get(next.body.trim()) || 0) + 1);
  }
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  return [...groups.values()]
    .filter((g) => g.count >= minRepeats && g.answers.size)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => ({ question: top(g.phrasings), answer: top(g.answers), asked: g.count }));
}

module.exports = { compile, getKnowledgeFor, estimateTokens, suggestFromHistory, TOKEN_BUDGET };
