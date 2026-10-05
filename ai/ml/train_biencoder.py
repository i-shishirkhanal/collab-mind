"""
ml/train_biencoder.py — domain-adapt a dense embedding model with a contrastive (InfoNCE) loss.

    python -m ml.train_biencoder --train ml/data/out/train.jsonl --base BAAI/bge-small-en-v1.5 --out models/biencoder-v1

Data: the same file the reranker trains on ({"query","passage","label"}); each positive passage becomes a triplet
(query, positive, a BM25 hard negative of the same query). Loss (MultipleNegativesRanking / InfoNCE with hard negatives):
for a batch of B triplets, query i must score its own positive above every other positive and every hard negative in
the batch, using cosine similarity / temperature. Passages of the same query that land in one batch are masked out so a
true positive is never used as a negative. The held-out TEST queries are never passed here.

The model is loaded and saved through sentence-transformers, so pooling and normalisation are preserved and the folder
works anywhere a `SentenceTransformer` does (including `ml.eval.run_retrieval_eval --dense`).
"""

from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path


def build_triplets(rows: list[dict], seed: int) -> list[tuple[str, str, str]]:
    rng = random.Random(seed)
    pos: dict[str, list[str]] = {}
    neg: dict[str, list[str]] = {}
    for r in rows:
        (pos if r["label"] == 1 else neg).setdefault(r["query"], []).append(r["passage"])
    out = []
    for q, ps in pos.items():
        for p in ps:
            if neg.get(q):
                out.append((q, p, rng.choice(neg[q])))
    if not out:
        raise ValueError("no (query, positive, hard negative) triplets could be built")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--base", default="BAAI/bge-small-en-v1.5")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--temperature", type=float, default=0.05)
    ap.add_argument("--max-seq-length", type=int, default=256)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--no-fp16", action="store_true")
    args = ap.parse_args()

    import torch
    import torch.nn.functional as F
    from sentence_transformers import SentenceTransformer

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    rows = [json.loads(x) for x in Path(args.train).read_text(encoding="utf-8").splitlines() if x.strip()]
    data = build_triplets(rows, args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    use_amp = (not args.no_fp16) and device.type == "cuda"
    model = SentenceTransformer(args.base, device=device.type)
    model.max_seq_length = args.max_seq_length
    model.float()
    model.train()
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = args.epochs * ((len(data) + args.batch_size - 1) // args.batch_size)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / max(1, int(0.1 * steps))) * max(0.0, 1 - s / steps))
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)

    def embed(texts: list[str]):
        feats = {k: v.to(device) for k, v in model.tokenize(texts).items()}
        with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=use_amp):
            vec = model(feats)["sentence_embedding"]
        return F.normalize(vec.float(), dim=-1)

    print(f"training {args.base} on {len(data)} triplets, {args.epochs} epochs, device={device.type}, fp16={use_amp}", flush=True)
    for epoch in range(1, args.epochs + 1):
        random.shuffle(data)
        running, t0, n = 0.0, time.time(), 0
        for s in range(0, len(data), args.batch_size):
            batch = data[s:s + args.batch_size]
            q, p, h = embed([b[0] for b in batch]), embed([b[1] for b in batch]), embed([b[2] for b in batch])
            logits = q @ torch.cat([p, h]).T / args.temperature            # B x 2B: positives then hard negatives
            same_query = torch.tensor([[batch[i][0] == batch[j][0] and i != j for j in range(len(batch))] for i in range(len(batch))],
                                      device=device)
            mask = torch.cat([same_query, torch.zeros_like(same_query)], dim=1)   # other positives of the SAME query are not negatives
            logits = logits.masked_fill(mask, float("-inf"))
            loss = F.cross_entropy(logits, torch.arange(len(batch), device=device))
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt)
            scaler.update()
            sched.step()
            running, n = running + loss.item(), n + 1
        print(f"epoch {epoch} infonce_loss={running / n:.4f} ({time.time() - t0:.0f}s)", flush=True)
    Path(args.out).mkdir(parents=True, exist_ok=True)
    model.save(args.out)
    print(f"saved to {args.out}", flush=True)


if __name__ == "__main__":
    main()
