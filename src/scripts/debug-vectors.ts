import { config } from "dotenv";
config();

import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";

async function debugVectors() {
  console.log("🔍 Vector Storage Debug");
  console.log("======================");

  try {
    // First, let's see what vectors we have stored
    const vectorCheck = await db.query(`
      SELECT 
        id, 
        title, 
        summary_embedding IS NOT NULL as has_vector,
        summary_embedding::text LIKE '%[%' as looks_like_array,
        LEFT(summary_embedding::text, 50) as vector_preview
      FROM links 
      LIMIT 3
    `);

    console.log("📊 Vector storage check:");
    vectorCheck.rows.forEach((row: any) => {
      console.log(`  ${row.id}. ${row.title}`);
      console.log(`     Has vector: ${row.has_vector}`);
      console.log(`     Looks like array: ${row.looks_like_array}`);
      console.log(`     Preview: ${row.vector_preview}...`);
    });

    if (vectorCheck.rows.length === 0) {
      console.log("❌ No vectors found, creating test data...");
      await createTestVector();
      return;
    }

    // Test a simple vector operation
    const linkId = vectorCheck.rows[0].id;
    console.log(`\n🧪 Testing vector operations on link ${linkId}:`);

    // Create a simple test vector
    const testVector = new Array(1536).fill(0.1);
    console.log(`Test vector length: ${testVector.length}`);

    // Try different vector query formats
    const formats = [
      `'[${testVector.join(',')}]'`,
      `'[${testVector.join(',')}]'::vector`,
      `ARRAY[${testVector.slice(0, 5).join(',')}]::float4[]` // Just first 5 elements
    ];

    for (let i = 0; i < formats.length; i++) {
      const format = formats[i];
      console.log(`\n  Format ${i + 1}: ${format.substring(0, 40)}...`);
      
      try {
        const result = await db.query(`
          SELECT 
            id, title,
            (summary_embedding <=> ${format}) as distance
          FROM links 
          WHERE id = $1
          LIMIT 1
        `, [linkId]);
        
        console.log(`    ✅ Success: ${result.rows.length} rows, distance: ${result.rows[0]?.distance}`);
      } catch (error: any) {
        console.log(`    ❌ Failed: ${error.message}`);
      }
    }

  } catch (error) {
    console.error("❌ Debug failed:", error);
  } finally {
    await db.close();
  }
}

async function createTestVector() {
  console.log("Creating test vector...");
  
  const embedding = await embeddingService.generateEmbedding("test content for vector storage");
  
  const result = await db.query(`
    INSERT INTO links (
      url, original_url, domain, title, summary, processing_status, summary_embedding
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [
    'https://test.example.com',
    'https://test.example.com', 
    'test.example.com',
    'Test Link',
    'Test content for debugging vectors',
    'completed',
    `[${embedding.join(',')}]`
  ]);

  console.log(`✅ Created test link with ID: ${result.rows[0].id}`);
  
  // Now run the debug again
  await debugVectors();
}

if (require.main === module) {
  debugVectors().catch(console.error);
}