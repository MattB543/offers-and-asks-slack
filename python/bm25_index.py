import os
import json
import pickle
import re
import sys
from typing import List, Dict, Tuple
from rank_bm25 import BM25Okapi


def preprocess_text(text: str) -> List[str]:
    text = re.sub(r"http\S+", "", text or "")
    text = re.sub(r"<@\w+>", "", text)
    text = re.sub(r"[^\w\s]", " ", text)
    tokens = (text or "").lower().split()
    return [t for t in tokens if t.strip()]


def build_index(corpus_json_path: str, index_path: str, k1: float = 1.2, b: float = 0.75) -> Tuple[int, int]:
    if not os.path.exists(corpus_json_path):
        raise FileNotFoundError(f"Corpus not found: {corpus_json_path}")

    with open(corpus_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    docs = data.get("docs", [])
    tokenized_docs: List[List[str]] = []
    doc_ids: List[str] = []

    for msg in docs:
        combined = f"{msg.get('text','')} {msg.get('username','')} {msg.get('channel','')}"
        if msg.get("thread_ts") and msg.get("thread_ts") != msg.get("ts"):
            combined = f"{combined} [threaded reply]"
        tokens = preprocess_text(combined)
        tokenized_docs.append(tokens)
        doc_ids.append(msg.get("id"))

    bm25 = BM25Okapi(tokenized_docs, k1=k1, b=b)

    os.makedirs(os.path.dirname(index_path), exist_ok=True)
    with open(index_path, "wb") as f:
        pickle.dump({"bm25": bm25, "doc_ids": doc_ids, "tokenized_corpus": tokenized_docs}, f)

    return len(docs), len(doc_ids)


def search(index_path: str, query: str, top_k: int = 50) -> List[Tuple[str, float]]:
    if not os.path.exists(index_path):
        return []
    with open(index_path, "rb") as f:
        data = pickle.load(f)
    bm25: BM25Okapi = data["bm25"]
    doc_ids: List[str] = data["doc_ids"]

    q_tokens = preprocess_text(query)
    scores = bm25.get_scores(q_tokens)
    import numpy as np

    top_idx = np.argsort(scores)[-top_k:][::-1]
    out: List[Tuple[str, float]] = []
    for idx in top_idx:
        if scores[idx] > 0:
            out.append((doc_ids[idx], float(scores[idx])))
    return out


def add_documents(index_path: str, docs: List[Dict], k1: float = 1.2, b: float = 0.75, rebuild_threshold: int = 1000) -> int:
    """Load existing index, append new docs, rebuild, and save. Returns number added."""
    tokenized_corpus: List[List[str]] = []
    doc_ids: List[str] = []
    bm25: BM25Okapi | None = None
    if os.path.exists(index_path):
        with open(index_path, "rb") as f:
            data = pickle.load(f)
            bm25 = data.get("bm25")
            doc_ids = list(data.get("doc_ids", []))
            tokenized_corpus = list(data.get("tokenized_corpus", []))
    else:
        # Initialize empty if no index exists
        print("Warning: No existing index found, creating new", file=sys.stderr)

    new_tokens: List[List[str]] = []
    new_ids: List[str] = []
    for msg in docs:
        combined = f"{msg.get('text','')} {msg.get('username','')} {msg.get('channel','')}"
        if msg.get("thread_ts") and msg.get("thread_ts") != msg.get("ts"):
            combined = f"{combined} [threaded reply]"
        tokens = preprocess_text(combined)
        new_tokens.append(tokens)
        new_ids.append(msg.get("id") or msg.get("ts") or msg.get("_id"))

    tokenized_corpus.extend(new_tokens)
    doc_ids.extend(new_ids)

    # Rebuild BM25
    bm25 = BM25Okapi(tokenized_corpus, k1=k1, b=b)

    dir_name = os.path.dirname(index_path)
    if dir_name:
        os.makedirs(dir_name, exist_ok=True)
    with open(index_path, "wb") as f:
        pickle.dump({"bm25": bm25, "doc_ids": doc_ids, "tokenized_corpus": tokenized_corpus}, f)

    return len(new_ids)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")

    b = sub.add_parser("build")
    b.add_argument("--corpus", required=True)
    b.add_argument("--index", required=True)
    b.add_argument("--k1", type=float, default=float(os.environ.get("BM25_K1", 1.2)))
    b.add_argument("--b", type=float, default=float(os.environ.get("BM25_B", 0.75)))

    s = sub.add_parser("search")
    s.add_argument("--index", required=True)
    s.add_argument("--query", required=True)
    s.add_argument("--top_k", type=int, default=50)

    a = sub.add_parser("add")
    a.add_argument("--index", required=True)
    a.add_argument("--k1", type=float, default=float(os.environ.get("BM25_K1", 1.2)))
    a.add_argument("--b", type=float, default=float(os.environ.get("BM25_B", 0.75)))

    args = parser.parse_args()

    if args.cmd == "build":
        total, ids = build_index(args.corpus, args.index, k1=args.k1, b=args.b)
        print(json.dumps({"ok": True, "docs": total, "ids": ids}))
    elif args.cmd == "search":
        results = search(args.index, args.query, args.top_k)
        print(json.dumps({"ok": True, "results": results}))
    elif args.cmd == "add":
        payload = json.load(sys.stdin)
        docs = payload.get("docs", [])
        added = add_documents(args.index, docs, k1=args.k1, b=args.b)
        print(json.dumps({"ok": True, "added": added}))
    else:
        parser.print_help()

