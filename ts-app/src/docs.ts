// Real bundled knowledge base for the RAG route.
// Keyword search runs over these actual texts — no canned answers.
export interface Doc {
  id: string;
  title: string;
  text: string;
}

export const DOCS: Doc[] = [
  {
    id: 'neatlogs-tracing',
    title: 'Neatlogs tracing basics',
    text: 'Neatlogs is an observability platform for AI agents. You call neatlogs.init() once, wrap your provider client (e.g. wrapOpenAI), and every LLM call, tool call and custom span lands in the dashboard as a trace made of spans. A trace is one run; a span is one step inside it.',
  },
  {
    id: 'neatlogs-spans',
    title: 'Neatlogs span kinds',
    text: 'Manual spans cover WORKFLOW (top-level entry point), AGENT (a reasoning step that decides), CHAIN (fixed step order), TOOL (a callable action), RETRIEVER (document lookup), EMBEDDING, GUARDRAIL (safety check) and MCP_TOOL. LLM, RERANKER and VECTOR_STORE spans are created with the trace() context manager; LLM spans normally come from auto-instrumentation via wrap().',
  },
  {
    id: 'modal-proxy-auth',
    title: 'Modal proxy auth format',
    text: 'Calling a Modal-hosted OpenAI-compatible endpoint requires proxy auth: pass the proxy token as an Authorization Bearer header in the form wk-<id>.ws-<secret>. The ws- proxy secret is shown in the endpoint proxy-auth section and is different from the as- Modal API token secret from Settings > Tokens.',
  },
  {
    id: 'kimi-k3-reasoning',
    title: 'Kimi K3 reasoning behavior',
    text: 'Kimi K3 always reasons and cannot disable thinking. Clients must omit thinking controls or pass reasoning_effort of low, high or max. Passing reasoning_effort none returns a 400 BadRequestError.',
  },
  {
    id: 'neatlogs-sessions',
    title: 'Neatlogs sessions and end-users',
    text: 'Group multi-turn conversations with a sessionId on the WORKFLOW root trace or via identify({ sessionId }). Attribute traces to your app users with endUserId. The backend rolls end-user identity up to the trace and session for filtering and analytics.',
  },
];

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'or',
  'in', 'on', 'for', 'with', 'what', 'how', 'why', 'when', 'where', 'who',
  'do', 'does', 'did', 'it', 'this', 'that', 'me', 'my', 'you', 'your', 'i',
]);

function keywords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Real keyword-overlap retrieval over DOCS. Returns top docs by score. */
export function retrieve(query: string, topK = 2): Doc[] {
  const keys = keywords(query);
  const scored = DOCS.map((d) => {
    const hay = `${d.title} ${d.text}`.toLowerCase();
    let score = 0;
    for (const k of keys) {
      if (hay.includes(k)) score += k.length > 5 ? 2 : 1;
      if (d.title.toLowerCase().includes(k)) score += 2;
    }
    return { d, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.d.id.localeCompare(b.d.id));
  const hits = scored.length > 0 ? scored : DOCS.map((d) => ({ d, score: 0 }));
  return hits.slice(0, topK).map((s) => s.d);
}
