"""Shared builders for the Phase 3 tests. Everything here is mocked at the HTTP
transport boundary (httpx.MockTransport), so the real clients, routing, retry
and parsing code runs — only the network is fake."""

import json
from dataclasses import replace

import httpx

from config import EmbeddingSettings, LLMSettings, RetrievalSettings, Settings
from llm.deepseek import DeepSeekClient
from llm.router import ModelRouter

FLASH = "deepseek-flash"
PRO = "deepseek-v4-pro"


def llm_settings(**kw) -> LLMSettings:
    base = LLMSettings(
        base_url="https://llm.test", api_key="sk-test-secret-key-1234567890",
        model_flash=FLASH, model_pro=PRO, timeout_seconds=5, max_retries=2,
        retry_base_delay=0.0, fallback_pro_to_flash=False, auto_route_research=True,
        flash_thinking="disabled", pro_thinking="enabled", max_output_tokens=512,
    )
    return replace(base, **kw)


def embedding_settings(**kw) -> EmbeddingSettings:
    base = EmbeddingSettings(
        base_url="https://emb.test/v1", api_key="emb-secret-token-123456", model="BAAI/bge-m3",
        dimensions=1024, batch_size=16, timeout_seconds=5, max_retries=2,
    )
    return replace(base, **kw)


def retrieval_settings(**kw) -> RetrievalSettings:
    base = RetrievalSettings(top_k=6, candidates=30, min_similarity=0.35, fts_rescue_min_similarity=0.25,
                             hybrid=True, rrf_k=60, context_max_chars=24000)
    return replace(base, **kw)


def settings(**kw) -> Settings:
    return Settings(llm=kw.get("llm", llm_settings()), embedding=kw.get("embedding", embedding_settings()),
                    retrieval=kw.get("retrieval", retrieval_settings()))


def completion_json(text="Hello [1].", model=FLASH, usage=True, finish="stop") -> dict:
    body = {"id": "x", "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish}]}
    if usage:
        body["usage"] = {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150,
                         "completion_tokens_details": {"reasoning_tokens": 7}}
    return body


class Recorder:
    """Scripted DeepSeek endpoint. `script` is a list of responses/exceptions
    consumed in order (the last one repeats). Records every request body."""

    def __init__(self, *script):
        self.script = list(script) or [httpx.Response(200, json=completion_json())]
        self.requests: list[dict] = []
        self.headers: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content) if request.content else {})
        self.headers.append(dict(request.headers))
        item = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(item, Exception):
            raise item
        return item

    @property
    def models(self):
        return [r.get("model") for r in self.requests]


def make_router(recorder: Recorder, **llm_kw) -> ModelRouter:
    s = llm_settings(**llm_kw)
    sleeps: list[float] = []

    async def fake_sleep(d):
        sleeps.append(d)

    router = ModelRouter(DeepSeekClient(s, transport=httpx.MockTransport(recorder)), s, sleep=fake_sleep)
    router.sleeps = sleeps  # type: ignore[attr-defined]
    return router


def sse_body(deltas, model=FLASH, usage=True) -> bytes:
    lines = []
    for d in deltas:
        lines.append("data: " + json.dumps({"model": model, "choices": [{"delta": {"content": d}}]}))
    lines.append("data: " + json.dumps({"model": model, "choices": [{"delta": {}, "finish_reason": "stop"}]}))
    if usage:
        lines.append("data: " + json.dumps({"model": model, "choices": [],
                                            "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}}))
    lines.append("data: [DONE]")
    return ("\n\n".join(lines) + "\n\n").encode()


def chunk(source_id="s1", idx=0, text="Chlorophyll absorbs red light.", name="biology.pdf",
          page=3, label="Page 3", sim=0.8, **kw) -> dict:
    return {"source_id": source_id, "chunk_index": idx, "content": text, "source_name": name,
            "page_number": page, "location_label": label, "similarity": sim, "source_type": "file", **kw}
