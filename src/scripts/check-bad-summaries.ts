import { config } from "dotenv";
import { db } from "../lib/database";

config();

async function checkBadSummaries() {
  try {
    console.log("🔍 Checking for remaining bad summaries...");
    
    // Count bad summaries
    const badCountResult = await db.query(`
      SELECT COUNT(*) as count
      FROM links 
      WHERE processing_status = 'completed'
        AND summary IS NOT NULL 
        AND summary LIKE 'Content from %'
    `);
    
    const badCount = parseInt(badCountResult.rows[0].count);
    console.log(`❌ Bad summaries found: ${badCount}`);
    
    // Count total completed links
    const totalResult = await db.query(`
      SELECT COUNT(*) as count
      FROM links 
      WHERE processing_status = 'completed'
        AND summary IS NOT NULL
    `);
    
    const totalCount = parseInt(totalResult.rows[0].count);
    console.log(`✅ Total completed links: ${totalCount}`);
    console.log(`📊 Bad summary percentage: ${Math.round((badCount/totalCount)*100)}%`);
    
    // Show a few examples if they exist
    if (badCount > 0) {
      console.log("\n📄 Sample bad summaries:");
      const samplesResult = await db.query(`
        SELECT id, url, summary
        FROM links 
        WHERE processing_status = 'completed'
          AND summary IS NOT NULL 
          AND summary LIKE 'Content from %'
        LIMIT 3
      `);
      
      samplesResult.rows.forEach((row: any, i: number) => {
        console.log(`${i+1}. ID ${row.id}: ${row.url}`);
        console.log(`   Summary: ${row.summary.substring(0, 100)}...`);
      });
    }
    
  } catch (error) {
    console.error("❌ Error checking summaries:", error);
  } finally {
    await db.close();
  }
}

checkBadSummaries();