import { config } from "dotenv";
import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";

config();

/**
 * Batch Regenerate Summaries and Embeddings Script
 * Processes in smaller batches with resume capability
 */
async function regenerateSummariesBatch() {
  console.log("🔄 BATCH REGENERATING SUMMARIES AND EMBEDDINGS");
  console.log("=".repeat(50));
  
  const BATCH_SIZE = 25; // Process 25 at a time to avoid timeouts
  
  try {
    // Find all links with bad summaries (those that start with "Content from")
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
    console.log(`📈 Found ${linksToRegenerate.length} links with bad summaries to regenerate in this batch`);
    
    if (linksToRegenerate.length === 0) {
      console.log("✅ No bad summaries found in this batch. All summaries look good!");
      
      // Check total remaining
      const totalBadResult = await db.query(`
        SELECT COUNT(*) as count
        FROM links 
        WHERE processing_status = 'completed'
          AND summary IS NOT NULL 
          AND summary LIKE 'Content from %'
      `);
      
      const totalRemaining = parseInt(totalBadResult.rows[0].count);
      console.log(`📊 Total remaining bad summaries: ${totalRemaining}`);
      return;
    }

    let processed = 0;
    let successful = 0;
    let failed = 0;

    for (const link of linksToRegenerate) {
      processed++;
      console.log(`\n🔄 Processing link ${processed}/${linksToRegenerate.length}: ${link.url.substring(0, 60)}...`);
      
      try {
        // Extract the content from the current bad summary
        // The bad summaries have format: "Content from URL: CONTENT"
        const contentMatch = link.summary.match(/Content from [^:]+: (.+)$/s);
        const extractedContent = contentMatch ? contentMatch[1] : link.summary;
        
        // Generate a proper summary using GPT-5-mini
        console.log(`  🤖 Generating new summary...`);
        const newSummary = await embeddingService.generateSummary(
          extractedContent,
          link.title || undefined,
          link.url
        );
        
        // Generate new embedding for the improved summary
        console.log(`  🧠 Generating new embedding...`);
        const summaryEmbedding = await embeddingService.generateEmbedding(newSummary);
        
        // Update the database
        await db.query(`
          UPDATE links 
          SET summary = $1, 
              summary_embedding = $2,
              updated_at = NOW()
          WHERE id = $3
        `, [newSummary, `[${summaryEmbedding.join(',')}]`, link.id]);
        
        console.log(`  ✅ Updated link ${link.id} successfully`);
        console.log(`     New: ${newSummary.substring(0, 80)}...`);
        
        successful++;

        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        console.error(`  ❌ Failed to regenerate link ${link.id}: ${error instanceof Error ? error.message : error}`);
        failed++;
      }
    }

    // Check how many are left
    const remainingResult = await db.query(`
      SELECT COUNT(*) as count
      FROM links 
      WHERE processing_status = 'completed'
        AND summary IS NOT NULL 
        AND summary LIKE 'Content from %'
    `);
    
    const remaining = parseInt(remainingResult.rows[0].count);

    console.log(`\n📊 BATCH COMPLETE:`);
    console.log(`   Processed: ${processed}`);
    console.log(`   Successful: ${successful}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Success rate: ${Math.round((successful / processed) * 100)}%`);
    console.log(`   Remaining bad summaries: ${remaining}`);
    
    if (remaining > 0) {
      console.log(`\n🔄 Run the script again to process the next batch of ${Math.min(remaining, BATCH_SIZE)} summaries`);
    } else {
      console.log(`\n🎉 All summaries have been regenerated!`);
    }
    
  } catch (error) {
    console.error("❌ Script failed:", error);
    throw error;
  } finally {
    await db.close();
  }
}

// Run the script
if (require.main === module) {
  regenerateSummariesBatch().catch(console.error);
}

export { regenerateSummariesBatch };