import json
from typing import List, Dict, Tuple
import sys
from sentence_transformers import CrossEncoder


class Reranker:
    def __init__(self, model_name: str = "BAAI/bge-reranker-v2-base"):
        self.model = CrossEncoder(model_name)

    def _prepare(self, msg: Dict) -> str:
        parts: List[str] = []
        if msg.get("text"):
            parts.append(f"Message: {msg['text']}")
        if msg.get("author"):
            parts.append(f"From: {msg['author']}")
        if msg.get("channel_name"):
            parts.append(f"Channel: #{msg['channel_name']}")
        if msg.get("thread_parent_text"):
            parts.append(f"Thread: {msg['thread_parent_text'][:100]}")
        return " | ".join(parts)

    def rerank(self, query: str, messages: List[Dict], top_k: int = 20):
        if not messages:
            return []
        pairs = [[query, self._prepare(m)] for m in messages]
        scores = self.model.predict(pairs)
        indexed = list(zip(range(len(messages)), scores))
        indexed.sort(key=lambda x: x[1], reverse=True)
        top = indexed[:top_k]
        return [(i, float(s)) for i, s in top]


def main():
    # Read JSON from stdin:
    # { "query": str, "messages": [ { ... } ], "top_k": int }
    payload = json.load(sys.stdin)
    query = payload.get("query", "")
    messages = payload.get("messages", [])
    top_k = int(payload.get("top_k", 20))
    reranker = Reranker(payload.get("model", "BAAI/bge-reranker-v2-base"))
    ranked = reranker.rerank(query, messages, top_k)
    print(json.dumps({"ok": True, "indices_and_scores": ranked}))


if __name__ == "__main__":
    main()

