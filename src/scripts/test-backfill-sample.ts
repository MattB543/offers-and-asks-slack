import { config } from "dotenv";
import { db } from "../lib/database";
import { linkExtractionService } from "../services/linkExtractionService";

config();

/**
 * Test Backfill with Small Sample
 * Tests the backfill logic with a small number of messages
 */
async function testBackfillSample() {
  console.log("🧪 TESTING BACKFILL WITH SMALL SAMPLE");
  console.log("=".repeat(50));
  
  try {
    // Get a small sample of messages with potential links
    const sampleResult = await db.query(`
      SELECT id, text, channel_name, user_name, ts
      FROM slack_message 
      WHERE text IS NOT NULL 
        AND text != ''
        AND COALESCE(subtype,'') NOT IN (
          'channel_join','channel_leave','bot_message','message_changed','message_deleted',
          'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
          'channel_archive','channel_unarchive','group_join','group_leave'
        )
        AND (text LIKE '%http://%' OR text LIKE '%https://%')
      ORDER BY id DESC
      LIMIT 5
    `);
    
    console.log(`📨 Found ${sampleResult.rows.length} sample messages to test with`);
    
    if (sampleResult.rows.length === 0) {
      console.log("ℹ️  No messages with links found for testing");
      return;
    }
    
    let totalLinksExtracted = 0;
    
    for (const message of sampleResult.rows) {
      console.log(`\n🔄 Processing message ${message.id}:`);
      console.log(`   Channel: ${message.channel_name || 'unknown'}`);
      console.log(`   User: ${message.user_name || 'unknown'}`);
      console.log(`   Text preview: ${message.text.substring(0, 100)}...`);
      
      try {
        const linksFound = await linkExtractionService.processMessageLinks(
          message.id,
          message.text,
          message.channel_name || 'unknown',
          message.user_name || 'unknown',
          message.ts
        );
        
        console.log(`   ✅ Extracted ${linksFound} links`);
        totalLinksExtracted += linksFound;
        
      } catch (error) {
        console.log(`   ❌ Error: ${error}`);
      }
    }
    
    console.log(`\n📊 SAMPLE TEST RESULTS:`);
    console.log(`   Messages processed: ${sampleResult.rows.length}`);
    console.log(`   Total links extracted: ${totalLinksExtracted}`);
    
    // Show current database state
    const statsResult = await db.query(`
      SELECT 
        COUNT(*) as total_links,
        COUNT(CASE WHEN processing_status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN processing_status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN processing_status = 'failed' THEN 1 END) as failed
      FROM links
    `);
    
    if (statsResult.rows.length > 0) {
      const stats = statsResult.rows[0];
      console.log(`\n📈 CURRENT DATABASE STATE:`);
      console.log(`   Total links: ${stats.total_links}`);
      console.log(`   Pending: ${stats.pending}`);
      console.log(`   Completed: ${stats.completed}`);
      console.log(`   Failed: ${stats.failed}`);
    }
    
    console.log(`\n✅ Sample test completed successfully!`);
    
  } catch (error) {
    console.error("❌ Sample test failed:", error);
    throw error;
  } finally {
    await db.close();
  }
}

// Run the test
testBackfillSample().catch(console.error);