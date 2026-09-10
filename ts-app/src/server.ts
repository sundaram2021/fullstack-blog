import express from 'express';
import {
  init,
  flush,
  shutdown,
  span,
  trace,
  log,
  identify,
  wrapOpenAI,
  PromptTemplate,
  UserPromptTemplate,
} from 'neatlogs';
import OpenAI from 'openai';
import { MODEL_NAME, assertConfigured } from './config.js';
import { DOCS, retrieve } from './docs.js';

const PORT = Number(process.env.PORT || 8001);

// Kimi K3 always reasons — omit thinking controls entirely.
const DEFAULT_PARAMS = { temperature: 0.3, max_tokens: 2048, top_p: 0.95 } as const;

async function main(): Promise<void> {
  await init({
    apiKey: process.env.NEATLOGS_API_KEY,
    workflowName: 'neatlogs-ts-app',
    tags: ['ts-sdk', 'kimi-k3'],
    captureLogs: true,
  });

  const { baseURL, apiKey } = assertConfigured();
  const client = wrapOpenAI(new OpenAI({ baseURL, apiKey }));

  type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

  async function chat(messages: Msg[], tools?: OpenAI.Chat.Completions.ChatCompletionTool[]) {
    return client.chat.completions.create({
      model: MODEL_NAME,
      messages,
      stream: false,
      ...DEFAULT_PARAMS,
      ...(tools ? { tools } : {}),
    });
  }

  const getWeather = span(
    { kind: 'TOOL', name: 'get_weather', toolName: 'get_weather' },
    async (city: string): Promise<string> => `It's sunny in ${city}.`,
  );

  const routeQuery = span(
    { kind: 'AGENT', name: 'route_query', role: 'Query router', goal: 'Pick retrieval strategy' },
    async (query: string): Promise<string> => {
      log('routing query len={n}', { n: query.length });
      const q = query.toLowerCase();
      if (['weather', 'temperature', 'rain', 'sunny', 'forecast'].some((k) => q.includes(k))) return 'tool';
      return 'retrieve';
    },
  );

  const groundedSystem = new PromptTemplate('Answer using this context:\n{{context}}');
  const groundedUser = new UserPromptTemplate('{{question}}');

  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.json({
      status: 'online',
      runtime: 'neatlogs TypeScript SDK',
      model: MODEL_NAME,
      endpoints: {
        docs: '/docs',
        chat: 'POST /chat',
        ask_docs: 'POST /ask-docs',
        agent: 'POST /agent',
        pipeline: 'POST /pipeline',
        session_chat: 'POST /session-chat',
      },
    });
  });

  app.get('/docs', (_req, res) => {
    res.json({ knowledge_base: DOCS.map((d) => ({ id: d.id, title: d.title })) });
  });

  const need = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

  // ---------- Route 1: plain chat ----------
  const chatHandler = span({ kind: 'WORKFLOW', name: 'chat', captureInput: false }, async (message: string) => {
    const r = await chat([{ role: 'user', content: message }]);
    return r.choices[0].message.content ?? '';
  });
  app.post('/chat', async (req, res) => {
    if (!need(req.body?.message)) return res.status(400).json({ detail: 'message (non-empty string) is required' });
    try {
      res.json({ reply: await chatHandler(req.body.message), model: MODEL_NAME });
    } catch (e: any) {
      res.status(e?.statusCode ?? 502).json({ detail: String(e?.message ?? e) });
    }
  });

  // ---------- Route 2: grounded RAG over the bundled docs ----------
  const askDocs = span({ kind: 'WORKFLOW', name: 'ask_docs', captureInput: false }, async (query: string) => {
    const docs = await trace({ name: 'retrieve_docs', kind: 'RETRIEVER' }, async (s) => {
      s.setAttribute('neatlogs.retriever.query', query);
      s.setAttribute('neatlogs.retriever.top_k', 2);
      const hits = retrieve(query, 2);
      s.setAttribute('neatlogs.retriever.documents', JSON.stringify(hits.map((d) => ({ id: d.id, title: d.title }))));
      log('retrieved {count} docs', { count: hits.length });
      return hits;
    });

    const reranked = await trace({ name: 'rerank_docs', kind: 'RERANKER' as any }, async (s) => {
      s.setAttribute('neatlogs.reranker.query', query);
      s.setAttribute('neatlogs.reranker.top_k', 1);
      s.setAttribute('neatlogs.reranker.input_documents', JSON.stringify(docs.map((d) => d.id)));
      const out = [...docs].sort((a, b) => b.text.length - a.text.length).slice(0, 1);
      s.setAttribute('neatlogs.reranker.output_documents', JSON.stringify(out.map((d) => d.id)));
      return out;
    });

    const context = reranked.map((d) => `[${d.title}] ${d.text}`).join('\n');
    const answer = await trace(
      {
        name: 'grounded_answer',
        kind: 'LLM' as any,
        promptTemplate: groundedSystem,
        promptVariables: { context },
        userPromptTemplate: groundedUser,
        userPromptVariables: { question: query },
      },
      async () => {
        const system = groundedSystem.compile({ context }) as string;
        const user = groundedUser.compile({ question: query }) as string;
        const r = await chat([
          { role: 'system', content: system },
          { role: 'user', content: user },
        ]);
        return r.choices[0].message.content ?? '';
      },
    );
    return { answer, sources: reranked.map((d) => d.id) };
  });
  app.post('/ask-docs', async (req, res) => {
    if (!need(req.body?.query)) return res.status(400).json({ detail: 'query (non-empty string) is required' });
    try {
      const out = await askDocs(req.body.query);
      res.json({ ...out, model: MODEL_NAME });
    } catch (e: any) {
      res.status(e?.statusCode ?? 502).json({ detail: String(e?.message ?? e) });
    }
  });

  // ---------- Route 3: tool-calling agent loop (real tool + real LLM) ----------
  const runAgent = span({ kind: 'AGENT', name: 'weather_agent', role: 'Weather assistant' }, async (userMsg: string) => {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ];
    const messages: Msg[] = [{ role: 'user', content: userMsg }];
    for (let i = 0; i < 3; i++) {
      const first = await chat(messages, tools);
      const msg = first.choices[0].message;
      if (!msg.tool_calls || msg.tool_calls.length === 0) return msg.content ?? '';
      for (const call of msg.tool_calls) {
        if (call.type !== 'function' || call.function.name !== 'get_weather') continue;
        const args = JSON.parse(call.function.arguments) as { city: string };
        const result = await getWeather(args.city);
        messages.push({
          role: 'assistant',
          content: msg.content,
          tool_calls: [
            { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } },
          ],
        });
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      if (i === 2) {
        const fin = await chat(messages);
        return fin.choices[0].message.content ?? '';
      }
    }
    return '';
  });
  const agentHandler = span({ kind: 'WORKFLOW', name: 'agent', captureInput: false }, runAgent);
  app.post('/agent', async (req, res) => {
    if (!need(req.body?.message)) return res.status(400).json({ detail: 'message (non-empty string) is required' });
    try {
      res.json({ reply: await agentHandler(req.body.message), model: MODEL_NAME });
    } catch (e: any) {
      res.status(e?.statusCode ?? 502).json({ detail: String(e?.message ?? e) });
    }
  });

  // ---------- Route 4: full pipeline (CHAIN + AGENT + RERANKER + VECTOR_STORE + GUARDRAIL + LOG) ----------
  const answerPipeline = span({ kind: 'CHAIN', name: 'answer_pipeline' }, async (query: string) => {
    const strategy = await routeQuery(query);

    await trace({ name: 'index_lookup', kind: 'VECTOR_STORE' as any }, async (s) => {
      s.setAttribute('neatlogs.vectordb.index_name', 'ts_docs');
      s.setAttribute('neatlogs.vectordb.embedding_model', 'keyword-overlap-v1');
      s.setAttribute('neatlogs.vectordb.vector_dimension', 1);
      s.setAttribute('neatlogs.vectordb.similarity_algorithm', 'keyword_overlap');
    });

    const docs = retrieve(query, 2);
    const context = docs.map((d) => `[${d.title}] ${d.text}`).join('\n');
    const r = await chat([
      { role: 'system', content: `Answer using this context:\n${context}` },
      { role: 'user', content: query },
    ]);
    const answer = r.choices[0].message.content ?? '';

    await trace({ name: 'validate_answer', kind: 'GUARDRAIL' }, async (s) => {
      s.setAttribute('neatlogs.guardrail.input', answer.slice(0, 500));
      const passed = answer.trim().length > 0;
      s.setAttribute('neatlogs.guardrail.passed', passed);
      s.setAttribute('neatlogs.guardrail.output', passed ? 'ok' : 'empty answer');
    });

    log('pipeline done strategy={s} answer_len={n}', { s: strategy, n: answer.length });
    return { answer, sources: docs.map((d) => d.id), strategy };
  });
  const pipelineHandler = span({ kind: 'WORKFLOW', name: 'pipeline', captureInput: false }, answerPipeline);
  app.post('/pipeline', async (req, res) => {
    if (!need(req.body?.query)) return res.status(400).json({ detail: 'query (non-empty string) is required' });
    try {
      const out = await pipelineHandler(req.body.query);
      res.json({ ...out, model: MODEL_NAME });
    } catch (e: any) {
      res.status(e?.statusCode ?? 502).json({ detail: String(e?.message ?? e) });
    }
  });

  // ---------- Route 5: session-tracked chat ----------
  app.post('/session-chat', async (req, res) => {
    if (!need(req.body?.message)) return res.status(400).json({ detail: 'message (non-empty string) is required' });
    const sessionId = need(req.body?.session_id) ? req.body.session_id : 'demo-session';
    const userId = need(req.body?.user_id) ? req.body.user_id : 'anonymous';
    try {
      const reply = await trace({ name: 'session_chat', kind: 'WORKFLOW', sessionId, endUserId: userId }, async () =>
        identify({ sessionId, endUserId: userId }, async () => {
          log('session turn user={u}', { u: userId });
          const r = await chat([{ role: 'user', content: req.body.message }]);
          return r.choices[0].message.content ?? '';
        }),
      );
      res.json({ reply, model: MODEL_NAME, session_id: sessionId });
    } catch (e: any) {
      res.status(e?.statusCode ?? 502).json({ detail: String(e?.message ?? e) });
    }
  });

  const server = app.listen(PORT, () => {
    console.log(`ts-app listening on http://127.0.0.1:${PORT} model=${MODEL_NAME}`);
  });

  const shutdownAll = async () => {
    server.close();
    try {
      await flush();
    } finally {
      await shutdown();
    }
  };
  process.on('SIGINT', () => void shutdownAll().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdownAll().then(() => process.exit(0)));
}

main().catch((e) => {
  console.error('fatal:', e?.message ?? e);
  process.exit(1);
});
