export const SEARCH_CONFIG = {
  hybrid: {
    semanticWeight: 0.7,
    rrfK: 60,
    initialCandidates: 100,
  },
  reranker: {
    model: "rerank-v3.5",
    enabledByDefault: true,
    provider: "cohere",
  },
  bm25: {
    indexPath: "./data/bm25_index.pkl",
    corpusJsonPath: "./data/bm25_corpus.json",
    topK: 100,
  },
  python: {
    // Override to a specific python executable if needed (e.g., 'py', 'python3')
    executable:
      process.env.PYTHON_EXE ||
      (process.platform === "win32" ? "py" : "python"),
    scriptsDir: "python",
    timeoutMs: 25_000,
  },
} as const;

export type SearchConfig = typeof SEARCH_CONFIG;
