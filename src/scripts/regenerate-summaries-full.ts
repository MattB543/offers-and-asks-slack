import { config } from "dotenv";
import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";

config();

/**
 * Full Regenerate Summaries Script
 * Processes ALL bad summaries in larger batches until complete
 */
async function regenerateAllSummaries() {
  console.log("🔄 FULL SUMMARY REGENERATION - PROCESSING ALL BAD SUMMARIES");
  console.log("=".repeat(60));
  
  const BATCH_SIZE = 50; // Larger batches for efficiency
  let totalProcessed = 0;
  let totalSuccessful = 0;
  let totalFailed = 0;
  let batchNumber = 0;
  
  try {
    while (true) {
      batchNumber++;
      
      // Find next batch of bad summaries
      const badSummariesResult = await db.query(`
        SELECT id, url, summary, title, description, word_count
        FROM links 
        WHERE processing_status = 'completed'
          AND summary IS NOT NULL 
          AND summary LIKE 'Content from %'
        ORDER BY id ASC
        LIMIT ${BATCH_SIZE}
      `);

      const linksToRegenerate = badSummariesResult.rows;
      
      if (linksToRegenerate.length === 0) {
        console.log("✅ ALL SUMMARIES REGENERATED! No more bad summaries found.");
        break;
      }

      console.log(`\n🔄 BATCH ${batchNumber}: Processing ${linksToRegenerate.length} links`);
      console.log(`📊 Global Progress: ${totalProcessed} processed, ${totalSuccessful} successful, ${totalFailed} failed`);
      
      let batchProcessed = 0;
      let batchSuccessful = 0;
      let batchFailed = 0;

      // Process this batch
      for (const link of linksToRegenerate) {
        batchProcessed++;
        totalProcessed++;
        
        const progress = `${batchProcessed}/${linksToRegenerate.length} (Global: ${totalProcessed})`;
        console.log(`🔄 Processing ${progress}: ${link.url.substring(0, 70)}...`);
        
        try {
          // Extract the content from the bad summary
          const contentMatch = link.summary.match(/Content from [^:]+: (.+)$/s);
          const extractedContent = contentMatch ? contentMatch[1] : link.summary;
          
          // Generate new summary with GPT-5-mini (fast mode)
          const newSummary = await embeddingService.generateSummary(
            extractedContent,
            link.title || undefined,
            link.url
          );
          
          // Generate new embedding
          const summaryEmbedding = await embeddingService.generateEmbedding(newSummary);
          
          // Update database
          await db.query(`
            UPDATE links 
            SET summary = $1, 
                summary_embedding = $2,
                updated_at = NOW()
            WHERE id = $3
          `, [newSummary, `[${summaryEmbedding.join(',')}]`, link.id]);
          
          console.log(`  ✅ ${progress} - SUCCESS`);
          batchSuccessful++;
          totalSuccessful++;

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 50));
          
        } catch (error) {
          console.error(`  ❌ ${progress} - FAILED: ${error instanceof Error ? error.message : error}`);
          batchFailed++;
          totalFailed++;
        }
      }

      console.log(`📊 BATCH ${batchNumber} COMPLETE: ${batchSuccessful}/${linksToRegenerate.length} successful (${Math.round((batchSuccessful/linksToRegenerate.length)*100)}%)`);
      
      // Check remaining count
      const remainingResult = await db.query(`
        SELECT COUNT(*) as count
        FROM links 
        WHERE processing_status = 'completed'
          AND summary IS NOT NULL 
          AND summary LIKE 'Content from %'
      `);
      
      const remaining = parseInt(remainingResult.rows[0].count);
      console.log(`📈 Remaining bad summaries: ${remaining}`);
      
      if (remaining === 0) {
        console.log("🎉 ALL SUMMARIES REGENERATED!");
        break;
      }
      
      // Brief pause between batches
      console.log("⏸️  Brief pause before next batch...");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`\n🎉 REGENERATION COMPLETE!`);
    console.log(`📊 FINAL STATS:`);
    console.log(`   Total Processed: ${totalProcessed}`);
    console.log(`   Successful: ${totalSuccessful}`);
    console.log(`   Failed: ${totalFailed}`);
    console.log(`   Success Rate: ${Math.round((totalSuccessful / totalProcessed) * 100)}%`);
    console.log(`   Batches Processed: ${batchNumber}`);
    
  } catch (error) {
    console.error("❌ Script failed:", error);
    throw error;
  } finally {
    await db.close();
  }
}

// Run the script
if (require.main === module) {
  regenerateAllSummaries().catch(console.error);
}

export { regenerateAllSummaries };