# Neatlogs + Modal Demo App

FastAPI application with 3 OpenAI endpoints fully traced with Neatlogs, hosted on Modal.

## Prerequisites

- [uv](https://github.com/astral-sh/uv) (installed)
- Modal Account (with `openai-secret` configured in your Modal dashboard)

## Setup

1. **Configure `.env`** (real Kimi-K3 inference, no mock):
   ```env
   NEATLOGS_API_KEY=...
   MODAL_TOKEN_ID=ak-...
   MODAL_TOKEN_SECRET=as-...
   # Kimi-K3 OpenAI-compatible endpoint on Modal:
   MODAL_PROXY_TOKEN_ID=wk-...
   MODAL_PROXY_TOKEN_SECRET=...
   MODAL_URL_ENDPOINT=https://jhasundarm--ep-kimi-k3-server.us-west.modal.direct
   MODEL_NAME=moonshotai/Kimi-K3
   ```
   > `MODAL_TOKEN_PROXY_ID` also works as an alias for `MODAL_PROXY_TOKEN_ID`.
   > `/v1` is appended to the endpoint automatically if missing.
   > Modal auth tokens at [modal.com/settings/tokens](https://modal.com/settings/tokens).

## Running the App

### Option 1: Local (real Kimi-K3 calls, traced)
```bash
python main.py
# http://127.0.0.1:8000/docs
```

### Option 2: Using the launcher (Windows-safe, fixes Modal ✓ encoding issue)
```bash
uv run python serve.py
```
This automatically configures your Modal token credentials from `.env` (if provided) and runs `modal serve main.py`.

### Option 3: Using the Modal CLI directly
```bash
uv run modal serve main.py
```

Modal will build the container image and provide an interactive development URL (e.g. `https://<username>--neatlogs-demo-app-fastapi-app-dev.modal.run`) where all endpoints are active and traced.

## Example Requests

Set base URL once (local or Modal dev URL):
```bash
# Local
BASE=http://127.0.0.1:8000
# Modal dev URL from `serve.py` output
BASE=https://<username>--neatlogs-demo-app-fastapi-app-dev.modal.run
```

Health check:
```bash
curl $BASE/
```

1. Simple chat (`POST /chat`):
```bash
curl -X POST $BASE/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'
```

2. RAG-style grounded answer (`POST /ask-docs`):
```bash
curl -X POST $BASE/ask-docs \
  -H "Content-Type: application/json" \
  -d '{"query": "What is Neatlogs?"}'
```

3. Tool-calling agent (`POST /agent`):
```bash
curl -X POST $BASE/agent \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the weather in San Francisco?"}'
```

### PowerShell (Windows)

```powershell
$BASE = "http://127.0.0.1:8000"
Invoke-RestMethod -Uri "$BASE/chat" -Method Post `
  -ContentType "application/json" -Body '{"message": "Hello!"}'
Invoke-RestMethod -Uri "$BASE/ask-docs" -Method Post `
  -ContentType "application/json" -Body '{"query": "What is Neatlogs?"}'
Invoke-RestMethod -Uri "$BASE/agent" -Method Post `
  -ContentType "application/json" -Body '{"message": "What is the weather in San Francisco?"}'
# Full pipeline: CHAIN + AGENT + EMBEDDING + RERANKER + VECTOR_STORE + GUARDRAIL + LOG + prompt templates
Invoke-RestMethod -Uri "$BASE/pipeline" -Method Post `
  -ContentType "application/json" -Body '{"query": "How does Neatlogs tracing work?"}'
# Session-tracked multi-turn chat (same session_id groups turns, user_id attributes end-user)
Invoke-RestMethod -Uri "$BASE/session-chat" -Method Post `
  -ContentType "application/json" -Body '{"message": "My name is Ada.", "session_id": "demo-1", "user_id": "ada"}'
Invoke-RestMethod -Uri "$BASE/session-chat" -Method Post `
  -ContentType "application/json" -Body '{"message": "What did I just tell you?", "session_id": "demo-1", "user_id": "ada"}'
```

### Python

```python
import requests
BASE = "http://127.0.0.1:8000"
print(requests.post(f"{BASE}/chat", json={"message": "Hello!"}).json())
print(requests.post(f"{BASE}/ask-docs", json={"query": "What is Neatlogs?"}).json())
print(requests.post(f"{BASE}/agent", json={"message": "Weather in SF?"}).json())
```
