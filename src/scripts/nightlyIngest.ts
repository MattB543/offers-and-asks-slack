import { config } from "dotenv";
config();
import { db } from "../lib/database";
import { bm25IndexService } from "../services/bm25Index";
import { SEARCH_CONFIG } from "../config/searchConfig";
import { spawn } from "child_process";
import * as fs from "fs";

async function fetchNewSlackExport(): Promise<any[]> {
  // Placeholder: In your system, nightly export likely arrives externally and is posted to /external/slack-message
  // If we need to fetch from a location, implement here. For now, return an empty list to avoid accidental work.
  return [];
}

async function saveMessagesToDb(messages: any[]): Promise<any[]> {
  // Messages are already saved by external ingestion in this app. If we wanted to persist here, we'd need DB inserts.
  return messages;
}

async function generateEmbeddingsFor(
  messages: Array<{ id: number; text: string }>
): Promise<void> {
  // Embedding generation is handled by existing backfill or ingestion flow; we skip here.
}

async function incrementalBm25Update(messages: any[]): Promise<number> {
  if (messages.length === 0) return 0;
  // Transform to docs expected by Python add: id, channel, username, text, thread_ts, ts
  const docs = messages.map((m) => ({
    id: `${m.channel_id}:${m.ts}`,
    channel: m.channel_name,
    username: m.user_name || m.username,
    text: m.text,
    thread_ts: m.thread_ts,
    ts: m.ts,
  }));
  return await new Promise<number>((resolve, reject) => {
    const py = spawn(
      SEARCH_CONFIG.python.executable,
      [
        `${SEARCH_CONFIG.python.scriptsDir}/bm25_index.py`,
        "add",
        "--index",
        SEARCH_CONFIG.bm25.indexPath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d) => (stdout += d.toString()));
    py.stderr.on("data", (d) => (stderr += d.toString()));
    py.on("error", reject);
    py.on("close", (code) => {
      if (code !== 0)
        return reject(new Error(stderr || `bm25 add exit ${code}`));
      try {
        const parsed = JSON.parse(stdout || "{}");
        resolve(Number(parsed.added) || 0);
      } catch (e) {
        reject(e);
      }
    });
    py.stdin.write(JSON.stringify({ docs }));
    py.stdin.end();
  });
}

async function updateIngestionLog(params: {
  processed: number;
  saved: number;
  indexUpdated: boolean;
  embeddingsCreated?: number;
  errorCount?: number;
}) {
  try {
    await db.query(
      `INSERT INTO ingestion_log (
         ingestion_timestamp, messages_processed, messages_saved,
         index_updated, embeddings_created, processing_time_seconds, error_count
       ) VALUES (now(), $1, $2, $3, $4, NULL, $5)`,
      [
        params.processed,
        params.saved,
        params.indexUpdated,
        params.embeddingsCreated || null,
        params.errorCount || 0,
      ]
    );
  } catch {}
}

async function main() {
  const start = Date.now();
  console.log("Nightly ingestion start");
  const newMessages = await fetchNewSlackExport();
  console.log(`New messages: ${newMessages.length}`);
  if (newMessages.length === 0) {
    await updateIngestionLog({ processed: 0, saved: 0, indexUpdated: false });
    console.log("No new messages. Done.");
    return;
  }
  const saved = (await saveMessagesToDb(newMessages)).length;
  await generateEmbeddingsFor(newMessages);

  // Before trying incremental update, ensure index exists
  const indexExists = fs.existsSync(SEARCH_CONFIG.bm25.indexPath);
  let added = 0;
  let rebuilt = false;
  if (!indexExists) {
    console.log("No existing index, doing full rebuild...");
    await bm25IndexService.rebuildIndex();
    rebuilt = true;
  } else {
    // Try incremental update
    try {
      added = await incrementalBm25Update(newMessages);
    } catch (e) {
      console.warn("Incremental update failed, rebuilding:", e);
      await bm25IndexService.rebuildIndex();
      rebuilt = true;
    }
  }

  const sec = (Date.now() - start) / 1000;
  await updateIngestionLog({
    processed: newMessages.length,
    saved,
    indexUpdated: rebuilt || added > 0,
  });
  console.log(`Nightly ingestion complete in ${sec.toFixed(1)}s`);
}

main().catch((e) => {
  console.error("nightlyIngest failed", e);
  process.exit(1);
});
