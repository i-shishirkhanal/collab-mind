"""
ml/data/make_indomain.py — a small in-domain test kit built from open-licensed study material.

    python -m ml.data.make_indomain [--questions-per-article 8]

1. Downloads a handful of English Wikipedia articles (CC BY-SA 4.0; credited in THIRD_PARTY_NOTICES.md) as
   stand-ins for lecture notes, splits them into sections and chunks them with the platform's own chunker.
2. Drafts study questions with a cheap LLM (one call per article, ml/llm.py budget cap) and answers them
   RAG-style from BM25-retrieved chunks (one call per question).
3. Writes ml/data/indomain/{chunks,questions,claims}.jsonl.

EVERYTHING DRAFTED HERE IS UNREVIEWED. `questions.jsonl` has `reviewed: false` and its relevant chunk is just the
chunk the question was written from; `claims.jsonl` has `label: null`. A human must confirm questions and label
claims (1 = supported, 0 = unsupported) before any number from this kit goes in the report. The LLM never labels
claims, because an LLM judge is one of the baselines being compared.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import httpx

from ml import llm
from ml.eval.bm25 import BM25
from ml.verifier.sentences import split_claims
from rag.chunker import chunk_blocks
from rag.extractor import Block

OUT = Path(__file__).parent / "indomain"
ARTICLES = ["Photosynthesis", "Operating system", "Machine learning", "Newton's laws of motion",
            "Mitochondrion", "Relational database"]
UA = {"User-Agent": "CollabMind-FYP/0.1 (student research project; contact via repo owner)"}

ANSWER_SYSTEM = ("Reply in English. Answer the question using ONLY the numbered passages. Cite each claim with its passage number "
                 "like [1]. Keep the answer under 90 words.")


def fetch_article(title: str) -> str:
    cache = OUT / "raw" / (re.sub(r"\W+", "_", title) + ".txt")
    if cache.exists():
        return cache.read_text(encoding="utf-8")
    r = httpx.get("https://en.wikipedia.org/w/api.php", headers=UA, timeout=60, params={
        "action": "query", "prop": "extracts", "explaintext": 1, "redirects": 1, "titles": title, "format": "json"})
    r.raise_for_status()
    text = next(iter(r.json()["query"]["pages"].values())).get("extract", "")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(text, encoding="utf-8")
    return text


def article_blocks(text: str) -> list[Block]:
    """Sections (== Heading ==) as location-labelled blocks; reference-style tails are dropped."""
    parts = re.split(r"\n==+\s*(.*?)\s*==+\n", "\n" + text)
    blocks = [Block(text=parts[0].strip(), location_label="Section: Introduction")] if parts[0].strip() else []
    for heading, body in zip(parts[1::2], parts[2::2]):
        if heading.lower() in {"see also", "references", "external links", "further reading", "notes", "citations"}:
            continue
        if body.strip():
            blocks.append(Block(text=body.strip(), location_label=f"Section: {heading}"))
    return blocks


def build(per_article: int) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    chunks: list[dict] = []
    for title in ARTICLES:
        for i, ch in enumerate(chunk_blocks(article_blocks(fetch_article(title)))):
            chunks.append({"id": f"{title}#{i}", "source": title, "location": ch.location_label, "text": ch.text})
    index = BM25({c["id"]: c["text"] for c in chunks})
    by_id = {c["id"]: c for c in chunks}
    _write("chunks", chunks)

    questions, claims = [], []
    for title in ARTICLES:
        own = [c for c in chunks if c["source"] == title and len(c["text"]) > 400]
        pick = own[:: max(1, len(own) // per_article)][:per_article]
        listing = "\n\n".join(f"[{n}] {c['text'][:900]}" for n, c in enumerate(pick, start=1))
        raw = llm.chat(f"Passages:\n{listing}\n\nWrite ONE specific study question per passage that the passage answers. "
                       "Return one line per passage as: <number>|<question>", max_tokens=900, temperature=0.3)
        for line in raw.splitlines():
            m = re.match(r"\s*\[?(\d+)\]?\s*[|:.)-]\s*(.+)", line)
            if m and 1 <= int(m.group(1)) <= len(pick):
                src = pick[int(m.group(1)) - 1]
                questions.append({"qid": f"q{len(questions) + 1}", "question": m.group(2).strip(), "source": title,
                                  "relevant_chunk_ids": [src["id"]], "reviewed": False})
    _write("questions", questions)

    for q in questions:
        top = [by_id[d] for d, _ in index.search(q["question"], k=6)]
        context = "\n\n".join(f"[{n}] {c['text'][:1200]}" for n, c in enumerate(top, start=1))
        answer = llm.chat(f"Passages:\n{context}\n\nQuestion: {q['question']}", system=ANSWER_SYSTEM, max_tokens=350)
        for claim in split_claims(answer):
            claims.append({"qid": q["qid"], "claim": claim, "answer": answer, "passages": [c["id"] for c in top],
                           "label": None})
    _write("claims", claims)
    print(f"{len(chunks)} chunks, {len(questions)} draft questions, {len(claims)} claims to label")


def _write(name: str, rows: list[dict]) -> None:
    (OUT / f"{name}.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions-per-article", type=int, default=8)
    build(ap.parse_args().questions_per_article)
