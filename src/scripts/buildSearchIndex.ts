import { bm25IndexService } from "../services/bm25Index";
import { SEARCH_CONFIG } from "../config/searchConfig";
import { spawn } from "child_process";
import { db } from "../lib/database";

async function runPythonBuild(): Promise<void> {
  return new Promise((resolve, reject) => {
    const py = spawn(
      SEARCH_CONFIG.python.executable,
      [
        `${SEARCH_CONFIG.python.scriptsDir}/bm25_index.py`,
        "build",
        "--corpus",
        SEARCH_CONFIG.bm25.corpusJsonPath,
        "--index",
        SEARCH_CONFIG.bm25.indexPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    py.stdout.on("data", (d) => process.stdout.write(d));
    py.stderr.on("data", (d) => process.stderr.write(d));
    py.on("error", reject);
    py.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`bm25_index.py exited with ${code}`));
    });
  });
}

async function main() {
  console.log("Exporting BM25 corpus from database...");
  const count = await bm25IndexService.exportCorpus();
  console.log(
    `Exported ${count} documents to ${SEARCH_CONFIG.bm25.corpusJsonPath}`
  );
  console.log("Building BM25 index via Python...");
  await runPythonBuild();
  console.log("BM25 index built and saved.");
  await db.upsertIndexMetadata("bm25", count);
  console.log("Index metadata updated.");
}

main().catch((e) => {
  console.error("buildSearchIndex failed", e);
  process.exit(1);
});
