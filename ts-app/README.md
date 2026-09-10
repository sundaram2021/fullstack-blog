# Neatlogs TS App (real inference, no mocks)

Small Express API on the **Neatlogs TypeScript SDK**, calling the real
Kimi-K3 OpenAI-compatible endpoint on Modal. Every LLM call is traced via
`wrapOpenAI`; routes add `WORKFLOW` / `AGENT` / `CHAIN` / `TOOL` /
`RETRIEVER` / `RERANKER` / `VECTOR_STORE` / `GUARDRAIL` / `LOG` spans,
prompt-template tracking, and session + end-user identity.

Secrets are read from the repo-root `.env` (shared with the Python app) —
nothing secret is stored in this folder:

```env
NEATLOGS_API_KEY=...
MODAL_PROXY_TOKEN_ID=wk-...      # (MODAL_TOKEN_PROXY_ID also works)
MODAL_PROXY_TOKEN_SECRET=ws-...  # the ws- proxy secret, NOT the as- API secret
MODAL_URL_ENDPOINT=https://<your-endpoint>.modal.direct   # /v1 appended automatically
MODEL_NAME=moonshotai/Kimi-K3
```

## Run

```bash
cd ts-app
npm install
npm run dev     # http://127.0.0.1:8001 (tsx, auto-reload)
# or: npm run build && npm start
```

Set `PORT=...` to change the port.

## Example requests

```bash
BASE=http://127.0.0.1:8001

curl $BASE/
curl -X POST $BASE/chat -H "Content-Type: application/json" \
  -d '{"message": "Explain low latency for LLM endpoints in three bullets."}'

# Grounded RAG over the bundled docs in src/docs.ts (real keyword retrieval)
curl -X POST $BASE/ask-docs -H "Content-Type: application/json" \
  -d '{"query": "What is the Modal proxy auth format?"}'

# Tool-calling agent (real get_weather tool loop)
curl -X POST $BASE/agent -H "Content-Type: application/json" \
  -d '{"message": "What is the weather in San Francisco?"}'

# Full pipeline: CHAIN + AGENT router + RERANKER + VECTOR_STORE + GUARDRAIL + LOG
curl -X POST $BASE/pipeline -H "Content-Type: application/json" \
  -d '{"query": "How does Neatlogs tracing work?"}'

# Session-tracked turns (same session_id groups them in the dashboard)
curl -X POST $BASE/session-chat -H "Content-Type: application/json" \
  -d '{"message": "My name is Ada.", "session_id": "demo-1", "user_id": "ada"}'
curl -X POST $BASE/session-chat -H "Content-Type: application/json" \
  -d '{"message": "What did I just tell you?", "session_id": "demo-1", "user_id": "ada"}'
```

PowerShell equivalents use `Invoke-RestMethod` with the same URLs and JSON bodies.

## Notes

- Kimi K3 always reasons: thinking controls are omitted (the server rejects
  `reasoning_effort: "none"` with 400).
- `GET /docs` lists the bundled knowledge-base entries used by `/ask-docs`.
- Traces appear under workflow `neatlogs-ts-app` (tags: `ts-sdk`, `kimi-k3`).
