import { config } from "dotenv";
config();

import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";

async function fixVectorQuery() {
  console.log("🔧 Vector Query Fix Test");
  console.log("========================");

  try {
    // Check if we have vectors
    const vectorCheck = await db.query(`
      SELECT id, title, summary_embedding IS NOT NULL as has_vector
      FROM links 
      WHERE summary_embedding IS NOT NULL
      LIMIT 3
    `);

    console.log(`📊 Found ${vectorCheck.rows.length} links with vectors`);
    
    if (vectorCheck.rows.length === 0) {
      console.log("❌ No vectors found. Run test-links-tables first.");
      return;
    }

    // Generate a test query embedding
    const queryEmbedding = await embeddingService.generateEmbedding("AI research and machine learning");
    console.log(`🧠 Generated query embedding with ${queryEmbedding.length} dimensions`);

    // Try the CORRECT format according to pgvector docs
    console.log("\n🎯 Testing CORRECT query format:");
    console.log("   SELECT * FROM links WHERE summary_embedding IS NOT NULL ORDER BY summary_embedding <=> $1 LIMIT 3");
    
    const result = await db.query(`
      SELECT 
        id, url, domain, title, summary, word_count,
        summary_embedding <=> $1 as distance
      FROM links 
      WHERE summary_embedding IS NOT NULL
      ORDER BY summary_embedding <=> $1
      LIMIT 3
    `, [`[${queryEmbedding.join(',')}]`]);

    console.log(`✅ Query returned ${result.rows.length} rows`);
    
    if (result.rows.length > 0) {
      console.log("\n📊 Results:");
      result.rows.forEach((row: any, index: number) => {
        const similarity = (1 - row.distance) * 100;
        console.log(`   ${index + 1}. [${similarity.toFixed(1)}%] ${row.domain} - ${row.title}`);
        console.log(`      Distance: ${row.distance.toFixed(4)}`);
        console.log(`      Summary: ${row.summary.substring(0, 80)}...`);
      });
    }

    // Also test the problematic format from our original code
    console.log("\n❌ Testing PROBLEMATIC format (with expressions in ORDER BY):");
    try {
      const badResult = await db.query(`
        SELECT 
          id, url, domain, title, summary, word_count,
          (summary_embedding <=> $1) as distance,
          (1 - (summary_embedding <=> $1)) as similarity
        FROM links 
        WHERE summary_embedding IS NOT NULL
        ORDER BY (1 - (summary_embedding <=> $1)) DESC
        LIMIT 3
      `, [`[${queryEmbedding.join(',')}]`]);
      
      console.log(`   Query returned ${badResult.rows.length} rows`);
    } catch (error: any) {
      console.log(`   Query failed: ${error.message}`);
    }

  } catch (error) {
    console.error("❌ Test failed:", error);
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  fixVectorQuery().catch(console.error);
}