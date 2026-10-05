"""
ml/cross_encoder_train.py — a plain PyTorch + Transformers training loop for single-logit cross-encoders.

Shared by the reranker (ml/train_reranker.py) and the verifier (ml/verifier/train_verifier.py). Written
directly against torch/transformers (no sentence-transformers training API), so it does not depend on that
library's version and every step of fine-tuning is visible:

    tokenise (text_a, text_b) pairs  ->  AutoModelForSequenceClassification(num_labels=1)
    -> logits -> BCE-with-logits loss -> AdamW + linear warmup/decay -> mixed precision (fp16) on GPU
    -> after each epoch run `dev_metric`; keep the best epoch's weights.

The saved folder is a normal Hugging Face model directory, loadable by sentence-transformers' CrossEncoder
(which rag/reranker.py and rag/verifier.py use at serving time).
"""

from __future__ import annotations

import json
import math
import random
import time
from pathlib import Path
from typing import Callable, Sequence

Pair = tuple[str, str]
Predict = Callable[[Sequence[Pair]], list[float]]       # (text_a, text_b) pairs -> raw logits


def make_predict(model, tokenizer, device, max_length: int, batch_size: int = 64) -> Predict:
    import torch

    def predict(pairs: Sequence[Pair]) -> list[float]:
        was_training = model.training
        model.eval()
        out: list[float] = []
        order = sorted(range(len(pairs)), key=lambda i: len(pairs[i][0]) + len(pairs[i][1]))   # less padding
        with torch.no_grad():
            for s in range(0, len(order), batch_size):
                idx = order[s:s + batch_size]
                enc = tokenizer([pairs[i][0] for i in idx], [pairs[i][1] for i in idx], truncation="longest_first",
                                max_length=max_length, padding=True, return_tensors="pt").to(device)
                logits = model(**enc).logits.view(-1).float().cpu().tolist()
                out.extend(zip(idx, logits))
        model.train(was_training)
        scores = [0.0] * len(pairs)
        for i, v in out:
            scores[i] = v
        return scores

    return predict


def train_cross_encoder(
    base: str,
    pairs: Sequence[Pair],
    labels: Sequence[int],
    out_dir: str,
    dev_metric: Callable[[Predict], tuple[float, dict]],
    *,
    epochs: int = 2,
    batch_size: int = 16,
    lr: float = 2e-5,
    max_length: int = 384,
    warmup_share: float = 0.1,
    weight_decay: float = 0.01,
    seed: int = 13,
    fp16: bool = True,
) -> dict:
    """Fine-tune `base`; returns {"best_score", "best_epoch", "history"} and writes the best model to out_dir.

    `dev_metric(predict)` returns (score to maximise, details to log); it is the ONLY place dev data is used.
    """
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

    random.seed(seed)
    torch.manual_seed(seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    use_amp = fp16 and device.type == "cuda"
    tokenizer = AutoTokenizer.from_pretrained(base)
    model = AutoModelForSequenceClassification.from_pretrained(base, num_labels=1, ignore_mismatched_sizes=True)
    model = model.float().to(device)    # fp32 master weights: GradScaler refuses fp16 parameters (newer transformers may load them)
    predict = make_predict(model, tokenizer, device, max_length)

    steps_per_epoch = math.ceil(len(pairs) / batch_size)
    total = steps_per_epoch * epochs
    no_decay = ("bias", "LayerNorm.weight", "layernorm", "layer_norm")
    params = [
        {"params": [p for n, p in model.named_parameters() if not any(k in n for k in no_decay)], "weight_decay": weight_decay},
        {"params": [p for n, p in model.named_parameters() if any(k in n for k in no_decay)], "weight_decay": 0.0},
    ]
    optimizer = torch.optim.AdamW(params, lr=lr)
    scheduler = get_linear_schedule_with_warmup(optimizer, max(1, int(warmup_share * total)), total)
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    loss_fn = torch.nn.BCEWithLogitsLoss()

    best, best_epoch, history = -math.inf, 0, []
    print(f"training {base} on {len(pairs)} pairs, {epochs} epochs, device={device.type}, fp16={use_amp}", flush=True)
    for epoch in range(1, epochs + 1):
        order = list(range(len(pairs)))
        random.shuffle(order)
        model.train()
        running, t0 = 0.0, time.time()
        for step, s in enumerate(range(0, len(order), batch_size), start=1):
            idx = order[s:s + batch_size]
            enc = tokenizer([pairs[i][0] for i in idx], [pairs[i][1] for i in idx], truncation="longest_first",
                            max_length=max_length, padding=True, return_tensors="pt").to(device)
            y = torch.tensor([float(labels[i]) for i in idx], device=device)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=use_amp):
                logits = model(**enc).logits.view(-1)
            loss = loss_fn(logits.float(), y)
            optimizer.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()
            running += loss.item()
            if step % 50 == 0 or step == steps_per_epoch:
                print(f"epoch {epoch} step {step}/{steps_per_epoch} loss={running / step:.4f} "
                      f"({time.time() - t0:.0f}s)", flush=True)
        score, details = dev_metric(predict)
        history.append({"epoch": epoch, "train_loss": running / steps_per_epoch, "dev_score": score, **details})
        print(f"epoch {epoch} dev_score={score:.4f} {details}", flush=True)
        if score > best:
            best, best_epoch = score, epoch
            Path(out_dir).mkdir(parents=True, exist_ok=True)
            model.save_pretrained(out_dir)
            tokenizer.save_pretrained(out_dir)
    Path(out_dir, "training_history.json").write_text(json.dumps(history, indent=2), encoding="utf-8")
    print(f"best epoch {best_epoch} (dev_score={best:.4f}) saved to {out_dir}", flush=True)
    return {"best_score": best, "best_epoch": best_epoch, "history": history}
