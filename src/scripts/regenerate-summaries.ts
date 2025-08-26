import { config } from "dotenv";
import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";

config();

/**
 * Regenerate Summaries and Embeddings Script
 * Fixes all the bad summaries that start with "Content from" and regenerates their embeddings
 */
async function regenerateSummaries() {
  console.log("🔄 REGENERATING SUMMARIES AND EMBEDDINGS");
  console.log("=".repeat(50));
  
  try {
    // Find all links with bad summaries (those that start with "Content from")
    const badSummariesResult = await db.query(`
      SELECT id, url, summary, title, description, word_count
      FROM links 
      WHERE processing_status = 'completed'
        AND summary IS NOT NULL 
        AND summary LIKE 'Content from %'
      ORDER BY id ASC
    `);

    const linksToRegenerate = badSummariesResult.rows;
    console.log(`📈 Found ${linksToRegenerate.length} links with bad summaries to regenerate`);
    
    if (linksToRegenerate.length === 0) {
      console.log("✅ No bad summaries found. All summaries look good!");
      return;
    }

    let processed = 0;
    let successful = 0;
    let failed = 0;

    for (const link of linksToRegenerate) {
      processed++;
      console.log(`\n🔄 Processing link ${processed}/${linksToRegenerate.length}: ${link.url}`);
      
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
        console.log(`     Old: ${link.summary.substring(0, 100)}...`);
        console.log(`     New: ${newSummary.substring(0, 100)}...`);
        
        successful++;

        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`  ❌ Failed to regenerate link ${link.id}: ${error instanceof Error ? error.message : error}`);
        failed++;
      }
    }

    console.log(`\n📊 REGENERATION COMPLETE:`);
    console.log(`   Total processed: ${processed}`);
    console.log(`   Successful: ${successful}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Success rate: ${Math.round((successful / processed) * 100)}%`);
    
  } catch (error) {
    console.error("❌ Script failed:", error);
    throw error;
  } finally {
    await db.close();
  }
}

// Run the script
if (require.main === module) {
  regenerateSummaries().catch(console.error);
}

export { regenerateSummaries };