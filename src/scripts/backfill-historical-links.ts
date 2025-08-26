import { config } from "dotenv";
import { db } from "../lib/database";
import { linkExtractionService } from "../services/linkExtractionService";

config();

/**
 * Backfill Historical Links Script
 * 
 * This script extracts and processes all links from existing Slack messages
 * in the database, adding them to the new links processing system.
 */

interface MessageRow {
  id: string;
  text: string;
  channel_name: string;
  user_name: string;
  ts: string;
}

async function backfillHistoricalLinks() {
  console.log("🔄 HISTORICAL LINKS BACKFILL");
  console.log("=".repeat(50));
  
  const startTime = Date.now();
  let totalMessages = 0;
  let messagesWithLinks = 0;
  let totalLinksExtracted = 0;
  let processedBatches = 0;
  
  try {
    // Get total count first
    console.log("📊 Analyzing existing messages...");
    const countResult = await db.query(`
      SELECT COUNT(*) as total
      FROM slack_message 
      WHERE text IS NOT NULL 
        AND text != ''
        AND COALESCE(subtype,'') NOT IN (
          'channel_join','channel_leave','bot_message','message_changed','message_deleted',
          'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
          'channel_archive','channel_unarchive','group_join','group_leave'
        )
        AND (text LIKE '%http://%' OR text LIKE '%https://%')
    `);
    
    const totalPotentialMessages = parseInt(countResult.rows[0].total);
    console.log(`📈 Found ${totalPotentialMessages} messages that might contain links`);
    
    if (totalPotentialMessages === 0) {
      console.log("ℹ️  No messages with potential links found. Backfill complete.");
      return;
    }

    // Process in batches to avoid memory issues
    const BATCH_SIZE = 500;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      console.log(`\n🔄 Processing batch ${processedBatches + 1} (offset: ${offset})...`);
      
      // Fetch batch of messages that likely contain links
      const batchResult = await db.query(`
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
        ORDER BY id ASC
        LIMIT $1 OFFSET $2
      `, [BATCH_SIZE, offset]);

      const messages: MessageRow[] = batchResult.rows;
      hasMore = messages.length === BATCH_SIZE;
      
      if (messages.length === 0) {
        break;
      }

      console.log(`📨 Processing ${messages.length} messages in this batch...`);
      
      // Process each message for link extraction
      let batchLinksExtracted = 0;
      let batchMessagesWithLinks = 0;
      
      for (const message of messages) {
        try {
          // Extract links from this message
          const linksFound = await linkExtractionService.processMessageLinks(
            message.id,
            message.text,
            message.channel_name || 'unknown',
            message.user_name || 'unknown',
            message.ts
          );
          
          if (linksFound > 0) {
            batchMessagesWithLinks++;
            batchLinksExtracted += linksFound;
          }
          
        } catch (error) {
          console.warn(`⚠️  Failed to process message ${message.id}: ${error}`);
          // Continue processing other messages
        }
      }
      
      // Update counters
      totalMessages += messages.length;
      messagesWithLinks += batchMessagesWithLinks;
      totalLinksExtracted += batchLinksExtracted;
      processedBatches++;
      
      console.log(`   ✅ Batch complete: ${batchLinksExtracted} links from ${batchMessagesWithLinks} messages`);
      console.log(`   📊 Running totals: ${totalLinksExtracted} links, ${messagesWithLinks} messages, ${totalMessages} processed`);
      
      // Progress indicator
      const progress = Math.min((offset + messages.length) / totalPotentialMessages * 100, 100);
      console.log(`   📈 Progress: ${progress.toFixed(1)}%`);
      
      offset += BATCH_SIZE;
      
      // Small delay to prevent overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Final statistics
    const endTime = Date.now();
    const durationMs = endTime - startTime;
    const durationSec = Math.round(durationMs / 1000);
    
    console.log("\n" + "=".repeat(50));
    console.log("📊 BACKFILL COMPLETE");
    console.log("=".repeat(50));
    console.log(`⏱️  Duration: ${durationSec}s`);
    console.log(`📨 Messages processed: ${totalMessages}`);
    console.log(`🔗 Messages with links: ${messagesWithLinks}`);
    console.log(`📈 Total links extracted: ${totalLinksExtracted}`);
    console.log(`📊 Links per message: ${messagesWithLinks > 0 ? (totalLinksExtracted / messagesWithLinks).toFixed(2) : 'N/A'}`);
    console.log(`⚡ Processing rate: ${totalMessages > 0 ? Math.round(totalMessages / (durationMs / 1000)) : 0} messages/sec`);
    
    // Show final database state
    const finalStats = await db.query(`
      SELECT 
        COUNT(*) as total_links,
        COUNT(CASE WHEN processing_status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN processing_status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN processing_status = 'failed' THEN 1 END) as failed,
        COUNT(DISTINCT domain) as unique_domains
      FROM links
    `);
    
    if (finalStats.rows.length > 0) {
      const stats = finalStats.rows[0];
      console.log("\n📈 DATABASE STATE AFTER BACKFILL:");
      console.log(`   Total links: ${stats.total_links}`);
      console.log(`   Pending: ${stats.pending}`);
      console.log(`   Completed: ${stats.completed}`);
      console.log(`   Failed: ${stats.failed}`);
      console.log(`   Unique domains: ${stats.unique_domains}`);
    }
    
    if (totalLinksExtracted > 0) {
      console.log("\n🔄 NEXT STEPS:");
      console.log("1. The link processing worker will automatically process pending links");
      console.log("2. Monitor progress with: GET /api/links/stats");
      console.log("3. Check processed links with: GET /api/links");
    } else {
      console.log("\nℹ️  No links found in historical messages.");
    }
    
  } catch (error) {
    console.error("❌ Backfill failed:", error);
    throw error;
  } finally {
    await db.close();
  }
}

async function main() {
  console.log("🚀 Historical Links Backfill Script");
  console.log("==================================");
  
  // Verify database connection
  const healthy = await db.healthCheck();
  if (!healthy) {
    console.error("❌ Database health check failed");
    process.exit(1);
  }
  console.log("✅ Database connection verified");
  
  // Check if links tables exist
  const tablesResult = await db.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_name IN ('links', 'message_links')
  `);
  
  if (tablesResult.rows.length !== 2) {
    console.error("❌ Links tables not found. Please run database setup first:");
    console.error("   npm run setup-db");
    process.exit(1);
  }
  console.log("✅ Links tables verified");
  
  // Check for existing links
  const existingLinksResult = await db.query('SELECT COUNT(*) as count FROM links');
  const existingLinksCount = parseInt(existingLinksResult.rows[0].count);
  
  if (existingLinksCount > 0) {
    console.log(`⚠️  Found ${existingLinksCount} existing links in database`);
    console.log("This script will add new links and update existing ones");
    console.log("");
  }
  
  await backfillHistoricalLinks();
  
  console.log("\n🎉 Backfill completed successfully!");
}

// Run the backfill if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error("❌ Unhandled error:", error);
    process.exit(1);
  });
}

export { backfillHistoricalLinks };