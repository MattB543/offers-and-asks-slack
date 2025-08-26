import { config } from "dotenv";
config();

import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";

async function testVectorWithProbes() {
  console.log("🔧 Vector Query with Probes Fix");
  console.log("==============================");

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
      console.log("❌ No vectors found. Creating test data...");
      await createTestData();
      return testVectorWithProbes(); // Retry after creating data
    }

    // Generate a test query embedding
    const queryEmbedding = await embeddingService.generateEmbedding("AI research and machine learning");
    console.log(`🧠 Generated query embedding with ${queryEmbedding.length} dimensions`);

    console.log("\n❌ First: Test WITHOUT probes setting (current broken behavior):");
    const brokenResult = await db.query(`
      SELECT 
        id, url, domain, title, summary,
        summary_embedding <=> $1 as distance
      FROM links 
      WHERE summary_embedding IS NOT NULL
      ORDER BY summary_embedding <=> $1
      LIMIT 3
    `, [`[${queryEmbedding.join(',')}]`]);

    console.log(`   Result: ${brokenResult.rows.length} rows`);

    console.log("\n✅ Now: Test WITH proper probes setting:");
    await db.query("BEGIN");
    await db.query("SET LOCAL ivfflat.probes = 10"); // Increase probes
    
    const fixedResult = await db.query(`
      SELECT 
        id, url, domain, title, summary,
        summary_embedding <=> $1 as distance
      FROM links 
      WHERE summary_embedding IS NOT NULL
      ORDER BY summary_embedding <=> $1
      LIMIT 3
    `, [`[${queryEmbedding.join(',')}]`]);

    await db.query("COMMIT");

    console.log(`   Result: ${fixedResult.rows.length} rows`);
    
    if (fixedResult.rows.length > 0) {
      console.log("\n📊 Semantic Search Results:");
      fixedResult.rows.forEach((row: any, index: number) => {
        const similarity = ((1 - row.distance) * 100).toFixed(1);
        console.log(`   ${index + 1}. [${similarity}%] ${row.domain} - ${row.title}`);
        console.log(`      Distance: ${row.distance.toFixed(4)}`);
        console.log(`      Summary: ${row.summary.substring(0, 80)}...`);
      });

      console.log("\n🎉 SUCCESS! Semantic search is working!");
    } else {
      console.log("❌ Still no results. Let's try without the index:");
      
      await db.query("BEGIN");
      await db.query("SET LOCAL enable_indexscan = off");
      
      const noIndexResult = await db.query(`
        SELECT 
          id, url, domain, title, summary,
          summary_embedding <=> $1 as distance
        FROM links 
        WHERE summary_embedding IS NOT NULL
        ORDER BY summary_embedding <=> $1
        LIMIT 3
      `, [`[${queryEmbedding.join(',')}]`]);

      await db.query("COMMIT");
      console.log(`   Without index: ${noIndexResult.rows.length} rows`);
      
      if (noIndexResult.rows.length > 0) {
        console.log("   → Index issue detected. Need to rebuild index with more data or different settings.");
      }
    }

  } catch (error) {
    console.error("❌ Test failed:", error);
  } finally {
    await db.close();
  }
}

async function createTestData() {
  console.log("Creating test data for vector search...");
  
  const testLinks = [
    {
      url: "https://arxiv.org/abs/2404.16698",
      domain: "arxiv.org", 
      title: "Governance of the Commons Simulation",
      summary: "Research paper exploring how large language models can cooperate in shared resource scenarios through strategic interactions and ethical reasoning."
    },
    {
      url: "https://askaforecaster.com",
      domain: "askaforecaster.com",
      title: "Ask A Forecaster", 
      summary: "A website where users can submit questions via email and receive answers from professional forecasters about future events and trends."
    },
    {
      url: "https://change.org",
      domain: "change.org",
      title: "Change.org - The world's platform for change",
      summary: "Global platform where over 560 million people create and sign petitions to make a difference in their communities through grassroots activism."
    }
  ];

  for (const link of testLinks) {
    const embedding = await embeddingService.generateEmbedding(link.summary);
    
    await db.query(`
      INSERT INTO links (
        url, original_url, domain, title, summary, processing_status, summary_embedding, message_count
      ) VALUES ($1, $1, $2, $3, $4, $5, $6, 1)
      ON CONFLICT (url) DO NOTHING
    `, [
      link.url, link.domain, link.title, link.summary, 'completed', `[${embedding.join(',')}]`
    ]);
  }
  
  console.log("✅ Test data created");
}

if (require.main === module) {
  testVectorWithProbes().catch(console.error);
}