import { config } from "dotenv";
config();

import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";

async function backfillMessageEmbeddings() {
  console.log("🧠 Backfill: starting per-message embeddings...");

  // Sanity: ensure DB reachable
  const ok = await db.healthCheck();
  if (!ok) throw new Error("Database not reachable");

  const batchSize = Number(process.env.BACKFILL_BATCH_SIZE || 200);
  const sleepMs = Number(process.env.BACKFILL_SLEEP_MS || 300);

  let totalUpdated = 0;
  let stagnantCycles = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await db.fetchSlackMessagesNeedingEmbedding(batchSize);
    if (rows.length === 0) break;

    // Filter out rows with empty text first to keep alignment
    const filtered = rows
      .map((r) => ({ id: r.id, text: (r.text || "").trim() }))
      .filter((r) => r.text.length > 0);

    if (filtered.length > 0) {
      const vectors = await embeddingService.generateMultipleEmbeddings(
        filtered.map((r) => r.text)
      );
      const pairs = filtered.map((r, i) => ({
        id: r.id,
        embedding: vectors[i] || [],
      }));
      await db.batchUpdateSlackMessageEmbeddings(pairs);
      totalUpdated += pairs.length;
      console.log(
        `✅ Backfill: updated ${pairs.length} (total ${totalUpdated})`
      );
      stagnantCycles = 0;
    }

    const skipped = rows.length - filtered.length;
    if (skipped > 0) {
      console.log(`↩️ Backfill: skipped ${skipped} empty texts`);
    }

    // If no valid rows updated, increment no-progress counter and bail after 3 cycles
    if (filtered.length === 0) {
      stagnantCycles += 1;
      if (stagnantCycles >= 3) {
        console.warn(
          "⚠️ Backfill: no progress for 3 cycles; exiting to prevent loop"
        );
        break;
      }
    }

    // Gentle pacing for rate limits
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  }

  console.log(`🎉 Backfill complete. Total messages embedded: ${totalUpdated}`);
}

if (require.main === module) {
  backfillMessageEmbeddings()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Backfill failed:", err);
      process.exit(1);
    })
    .finally(async () => {
      await db.close();
    });
}

export { backfillMessageEmbeddings };
