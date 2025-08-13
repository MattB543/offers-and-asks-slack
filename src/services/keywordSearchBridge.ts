import { spawn } from "child_process";
import { SEARCH_CONFIG } from "../config/searchConfig";

export class KeywordSearchBridge {
  async search(
    query: string,
    topK: number = 50
  ): Promise<Array<[string, number]>> {
    const results = await new Promise<Array<[string, number]>>(
      (resolve, reject) => {
        const py = spawn(
          SEARCH_CONFIG.python.executable,
          [
            `${SEARCH_CONFIG.python.scriptsDir}/bm25_index.py`,
            "search",
            "--index",
            SEARCH_CONFIG.bm25.indexPath,
            "--query",
            query,
            "--top_k",
            String(topK),
          ],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        let stdout = "";
        let stderr = "";
        py.stdout.on("data", (d) => (stdout += d.toString()));
        py.stderr.on("data", (d) => (stderr += d.toString()));
        py.on("error", reject);
        py.on("close", (code) => {
          if (code !== 0) {
            return reject(new Error(`bm25 search failed: ${stderr}`));
          }
          try {
            const parsed = JSON.parse(stdout || "{}");
            resolve((parsed.results || []) as Array<[string, number]>);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    return results;
  }
}

export const keywordSearchBridge = new KeywordSearchBridge();
