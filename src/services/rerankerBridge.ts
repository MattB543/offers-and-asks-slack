import { spawn } from "child_process";
import { SEARCH_CONFIG } from "../config/searchConfig";

export class RerankerBridge {
  async rerank(
    query: string,
    messages: any[],
    topK: number = 20,
    model: string = SEARCH_CONFIG.reranker.model
  ): Promise<Array<{ index: number; score: number }>> {
    const payload = JSON.stringify({ query, messages, top_k: topK, model });
    const ranked = await new Promise<Array<{ index: number; score: number }>>(
      (resolve, reject) => {
        const py = spawn(
          SEARCH_CONFIG.python.executable,
          [`${SEARCH_CONFIG.python.scriptsDir}/reranker.py`],
          { stdio: ["pipe", "pipe", "pipe"] }
        );
        let stdout = "";
        let stderr = "";
        py.stdout.on("data", (d) => (stdout += d.toString()));
        py.stderr.on("data", (d) => (stderr += d.toString()));
        py.on("error", reject);
        py.on("close", (code) => {
          if (code !== 0)
            return reject(new Error(stderr || `reranker exit ${code}`));
          try {
            const parsed = JSON.parse(stdout || "{}");
            const arr = (parsed.indices_and_scores || []) as Array<
              [number, number]
            >;
            resolve(arr.map(([i, s]) => ({ index: i, score: s })));
          } catch (e) {
            reject(e);
          }
        });
        py.stdin.write(payload);
        py.stdin.end();
      }
    );
    return ranked;
  }
}

export const rerankerBridge = new RerankerBridge();
