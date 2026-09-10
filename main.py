"""
Neatlogs + Modal demo app with 3 web routes calling a real
OpenAI-compatible inference endpoint (Kimi-K3 on Modal),
fully traced with Neatlogs.

Env (.env):
    NEATLOGS_API_KEY=...
    MODAL_PROXY_TOKEN_ID=...        (or MODAL_TOKEN_PROXY_ID)
    MODAL_PROXY_TOKEN_SECRET=...    (or MODAL_TOKEN_PROXY_SECRET)
    MODAL_URL_ENDPOINT=https://...modal.direct   (/v1 appended if missing)
    MODEL_NAME=moonshotai/Kimi-K3   (optional)

Local run:
    python main.py  (uvicorn on 127.0.0.1:8000)
Modal run:
    python serve.py
"""

import json
import logging
import os
import modal
import neatlogs
from neatlogs import SystemPromptTemplate, UserPromptTemplate
from openai import OpenAI
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("neatlogs-demo")

# ---- Init Neatlogs once at import time (not per-request) ----
_NEATLOGS_KEY = os.environ.get("NEATLOGS_API_KEY", "").strip()
if _NEATLOGS_KEY:
    try:
        neatlogs.init(
            api_key=_NEATLOGS_KEY,
            workflow_name="neatlogs-demo-app",
            tags=["modal-demo", "kimi-k3"],
            capture_logs=True,  # LOG spans from neatlogs.log()/logging/print
        )
    except Exception as e:
        print(f"[neatlogs] init failed: {e}")

app = modal.App("neatlogs-demo-app")

image = modal.Image.debian_slim().pip_install(
    "neatlogs", "openai", "fastapi", "python-dotenv", "pydantic"
)

web_app = FastAPI(title="Neatlogs Demo App")


class ChatRequest(BaseModel):
    message: str


class AskDocsRequest(BaseModel):
    query: str


class AgentRequest(BaseModel):
    message: str


class PipelineRequest(BaseModel):
    query: str


class SessionChatRequest(BaseModel):
    message: str
    session_id: str = "demo-session"
    user_id: str = "anonymous"


# Prompt templates for template-version tracking (see /pipeline).
_grounded_system_template = SystemPromptTemplate([
    {"role": "system", "content": "Answer using this context:\n{{context}}"},
])
_grounded_user_template = UserPromptTemplate([
    {"role": "user", "content": "{{question}}"},
])


@web_app.get("/")
def read_root():
    return {
        "status": "online",
        "message": "Neatlogs Demo App is running!",
        "endpoints": {
            "docs": "/docs",
            "chat": "POST /chat",
            "ask_docs": "POST /ask-docs",
            "agent": "POST /agent",
            "pipeline": "POST /pipeline",
            "session_chat": "POST /session-chat",
        },
    }


def _clean_token(v: str) -> str:
    """Strip whitespace, quotes, and an optional 'Bearer ' prefix users paste."""
    v = v.strip().strip('"').strip("'").strip()
    if v.lower().startswith("bearer "):
        v = v[7:].strip()
    return v


def _env_first(*names: str) -> str:
    """Return first non-empty env var among names (handles naming variants)."""
    for n in names:
        v = _clean_token(os.environ.get(n, ""))
        if v:
            return v
    return ""


MODEL_NAME = os.environ.get("MODEL_NAME", "moonshotai/Kimi-K3").strip() or "moonshotai/Kimi-K3"

DEFAULT_CHAT_PARAMS = {
    "temperature": 0.3,
    "max_tokens": 2048,
    "top_p": 0.95,
    # NOTE: Kimi K3 always reasons — server rejects reasoning_effort="none".
    # Omit thinking controls entirely (or use "low"/"high"/"max").
}


def _resolve_base_url() -> str:
    raw = _env_first("MODAL_URL_ENDPOINT", "MODAL_ENDPOINT_URL", "MODAL_BASE_URL")
    if not raw:
        return ""
    raw = raw.rstrip("/")
    if not raw.endswith("/v1"):
        raw += "/v1"
    return raw


def _resolve_proxy_api_key() -> str:
    pid = _env_first("MODAL_PROXY_TOKEN_ID", "MODAL_TOKEN_PROXY_ID")
    psecret = _env_first("MODAL_PROXY_TOKEN_SECRET", "MODAL_TOKEN_PROXY_SECRET")
    if pid and psecret:
        return f"{pid}.{psecret}"
    # allow a pre-combined key as fallback
    return _env_first("MODAL_PROXY_API_KEY", "OPENAI_API_KEY")


_client = None


def get_client():
    """Return a neatlogs-wrapped OpenAI-compatible client for Kimi-K3. No mock."""
    global _client
    if _client is not None:
        return _client
    base_url = _resolve_base_url()
    pid = _env_first("MODAL_PROXY_TOKEN_ID", "MODAL_TOKEN_PROXY_ID")
    psecret = _env_first("MODAL_PROXY_TOKEN_SECRET", "MODAL_TOKEN_PROXY_SECRET")
    api_key = f"{pid}.{psecret}" if (pid and psecret) else _env_first("MODAL_PROXY_API_KEY", "OPENAI_API_KEY")
    missing = []
    if not base_url:
        missing.append("MODAL_URL_ENDPOINT (not found)")
    if not pid:
        missing.append("MODAL_PROXY_TOKEN_ID (not found; MODAL_TOKEN_PROXY_ID alias also checked)")
    if not psecret:
        missing.append("MODAL_PROXY_TOKEN_SECRET (not found; MODAL_TOKEN_PROXY_SECRET alias also checked)")
    if missing:
        raise HTTPException(
            status_code=502,
            detail=f"Inference endpoint not configured. Missing: {', '.join(missing)}. "
            "Add them to .env and FULLY restart (Ctrl+C, then python main.py again). "
            "Edits to .env do not hot-reload.",
        )
    # The endpoint wants `Bearer wk-<id>.ws-<secret>`. The Modal API secret
    # (`as-...` from Settings > Tokens) is NOT the proxy secret — that 401s.
    if psecret.startswith("as-"):
        raise HTTPException(
            status_code=502,
            detail="Wrong proxy secret: it starts with 'as-' (that's your Modal API "
            "token secret). The inference endpoint needs the proxy secret starting "
            "with 'ws-'. In .env, MODAL_PROXY_TOKEN_SECRET must be the ws-... value "
            "shown in your endpoint's proxy-auth section, so the key becomes "
            "wk-....ws-.... Fix .env, then FULLY restart the server.",
        )
    try:
        _client = neatlogs.wrap(OpenAI(base_url=base_url, api_key=api_key))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to init inference client: {e}")
    return _client


def chat_completion(messages, tools=None):
    """Single place for all LLM calls so tracing + params stay consistent."""
    client = get_client()
    kwargs = dict(DEFAULT_CHAT_PARAMS)
    if tools is not None:
        kwargs["tools"] = tools
    return client.chat.completions.create(
        model=MODEL_NAME,
        messages=messages,
        stream=False,
        **kwargs,
    )


@neatlogs.span(kind="RETRIEVER", name="retrieve_docs")
def retrieve_docs(query: str) -> list[str]:
    # fake retrieval (replace with real vector search)
    return [f"Fake doc chunk relevant to: {query}"]




# ---------- Route 1: simple single-call chat endpoint ----------
@web_app.post("/chat")
@neatlogs.span(kind="WORKFLOW", name="chat")
def chat(payload: ChatRequest):
    response = chat_completion(
        messages=[{"role": "user", "content": payload.message}],
    )
    return {"reply": response.choices[0].message.content, "model": MODEL_NAME}


# ---------- Route 2: multi-step RAG-style endpoint (grouped into one trace) ----------
@web_app.post("/ask-docs")
@neatlogs.span(kind="WORKFLOW", name="ask_docs")
def ask_docs(payload: AskDocsRequest):
    query = payload.query

    # step 1: fake retrieval (replace with real vector search)
    docs = retrieve_docs(query)

    # step 2: generation grounded in retrieved docs
    context = "\n".join(docs)
    response = chat_completion(
        messages=[
            {"role": "system", "content": f"Answer using this context:\n{context}"},
            {"role": "user", "content": query},
        ],
    )
    return {"answer": response.choices[0].message.content, "sources": docs, "model": MODEL_NAME}


@neatlogs.span(kind="TOOL", name="get_weather")
def get_weather(city: str) -> str:
    return f"It's sunny in {city}."


@neatlogs.span(kind="AGENT", name="route_query", role="Query router",
                goal="Pick retrieval vs direct-answer strategy")
def route_query(query: str) -> str:
    """Decides the pipeline strategy (no LLM — pure routing logic)."""
    neatlogs.log("routing query len={n}", n=len(query))
    q = query.lower()
    if any(k in q for k in ("weather", "temperature", "rain", "sunny", "forecast")):
        return "tool"
    return "retrieve"


@neatlogs.span(kind="EMBEDDING", name="embed_query")
def embed_query(text: str) -> list[float]:
    """Demo embedding (deterministic placeholder — swap for a real embedder)."""
    import hashlib
    h = hashlib.sha256(text.encode()).digest()
    return [b / 255.0 for b in h[:16]]


@neatlogs.span(kind="CHAIN", name="answer_pipeline")
def answer_pipeline(query: str) -> dict:
    strategy = route_query(query)
    vec = embed_query(query)
    neatlogs.log("embedded query dim={dim} strategy={s}", dim=len(vec), s=strategy)
    logger.info("pipeline strategy=%s for query len=%d", strategy, len(query))

    # VECTOR_STORE block (custom store — attributes per docs).
    with neatlogs.trace("index_query_vec", kind="VECTOR_STORE") as span:
        span.set_attribute("neatlogs.vectordb.index_name", "demo_kb")
        span.set_attribute("neatlogs.vectordb.embedding_model", "demo-sha256-16d")
        span.set_attribute("neatlogs.vectordb.vector_dimension", len(vec))
        span.set_attribute("neatlogs.vectordb.similarity_algorithm", "cosine")

    docs = retrieve_docs(query)

    # RERANKER block (local top-n reorder — attributes per docs).
    with neatlogs.trace("rerank_docs", kind="RERANKER") as span:
        span.set_attribute("neatlogs.reranker.query", query)
        span.set_attribute("neatlogs.reranker.top_k", 1)
        span.set_attribute("neatlogs.reranker.input_documents", json.dumps(docs))
        reranked = sorted(docs, key=len, reverse=True)[:1]
        span.set_attribute("neatlogs.reranker.output_documents", json.dumps(reranked))

    context = "\n".join(reranked)
    # Prompt-template tracking: template + compiled vars linked to the LLM span.
    with neatlogs.trace("grounded_answer", kind="LLM",
                        system_prompt_template=_grounded_system_template,
                        user_prompt_template=_grounded_user_template):
        messages = _grounded_system_template.compile(context=context) \
            + _grounded_user_template.compile(question=query)
        response = chat_completion(messages=messages)
    answer = response.choices[0].message.content

    # GUARDRAIL block (custom check — attributes per docs).
    with neatlogs.trace("validate_answer", kind="GUARDRAIL") as span:
        span.set_attribute("neatlogs.guardrail.input", answer[:500])
        passed = len(answer.strip()) > 0 and "PLACEHOLDER_LEAK" not in answer
        span.set_attribute("neatlogs.guardrail.passed", passed)
        span.set_attribute("neatlogs.guardrail.output",
                           "ok" if passed else "empty answer")

    neatlogs.log("pipeline done strategy={s} answer_len={n}", s=strategy, n=len(answer or ""))
    return {"answer": answer, "sources": reranked, "strategy": strategy, "model": MODEL_NAME}


# ---------- Route 4: full RAG pipeline (CHAIN + AGENT + EMBEDDING + RERANKER +
#            VECTOR_STORE + GUARDRAIL + LOG + prompt templates, 1 LLM call) ----------
@web_app.post("/pipeline")
@neatlogs.span(kind="WORKFLOW", name="pipeline", capture_stdout=True)
def pipeline(payload: PipelineRequest):
    print(f"pipeline query: {payload.query[:80]}")
    return answer_pipeline(payload.query)


# ---------- Route 5: session-tracked chat (Sessions + end-user identity) ----------
@web_app.post("/session-chat")
@neatlogs.span(kind="WORKFLOW", name="session_chat")
def session_chat(payload: SessionChatRequest):
    # Groups turns by session_id; attributes traces to end_user_id in dashboard.
    with neatlogs.identify(session_id=payload.session_id or "demo-session",
                           end_user_id=payload.user_id or "anonymous"):
        neatlogs.log("session turn user={u}", u=payload.user_id or "anonymous")
        response = chat_completion(
            messages=[{"role": "user", "content": payload.message}],
        )
    return {"reply": response.choices[0].message.content,
            "model": MODEL_NAME,
            "session_id": payload.session_id or "demo-session"}


# ---------- Route 3: tool-calling loop endpoint ----------
@web_app.post("/agent")
@neatlogs.span(kind="WORKFLOW", name="agent")
def agent(payload: AgentRequest):
    user_msg = payload.message

    tools = [{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather for a city",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }]

    messages = [{"role": "user", "content": user_msg}]
    first = chat_completion(messages=messages, tools=tools)
    msg = first.choices[0].message

    if msg.tool_calls:
        for call in msg.tool_calls:
            args = json.loads(call.function.arguments)
            result = get_weather(**args)

            # OpenAI SDK message objects -> dicts for the follow-up call
            messages.append({
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.function.name,
                            "arguments": call.function.arguments,
                        },
                    }
                ],
            })
            messages.append({
                "role": "tool",
                "tool_call_id": call.id,
                "content": result,
            })

        final = chat_completion(messages=messages)
        return {"reply": final.choices[0].message.content, "model": MODEL_NAME}

    return {"reply": msg.content, "model": MODEL_NAME}


@app.function(
    image=image,
    secrets=[
        modal.Secret.from_dotenv(__file__),
    ],
)
@modal.asgi_app()
def fastapi_app():
    return web_app


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:web_app", host="127.0.0.1", port=8000, reload=True)