import { config } from "dotenv";
config();

import { db } from "../lib/database";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Run the links tables migration
 */
async function runLinksMigration(closeConnection: boolean = true): Promise<void> {
  console.log("🚀 Running links tables migration...");

  try {
    // Check if tables already exist
    const tablesExist = await checkTablesExist();
    if (tablesExist) {
      console.log("⚠️  Links tables already exist. Skipping migration.");
      return;
    }

    // Read the migration SQL file
    const migrationPath = join(__dirname, "../../database/migrations/001_add_links_tables.sql");
    const migrationSQL = readFileSync(migrationPath, "utf8");

    console.log("📄 Loaded migration SQL from:", migrationPath);

    // Execute the migration in a transaction
    await db.query("BEGIN");
    
    console.log("🔄 Executing migration...");
    await db.query(migrationSQL);
    
    await db.query("COMMIT");

    console.log("✅ Links tables migration completed successfully!");

    // Verify tables were created
    await verifyTables();

  } catch (error) {
    console.error("❌ Migration failed:", error);
    try {
      await db.query("ROLLBACK");
      console.log("🔄 Transaction rolled back");
    } catch (rollbackError) {
      console.error("❌ Rollback failed:", rollbackError);
    }
    throw error; // Re-throw to be handled by caller
  } finally {
    if (closeConnection) {
      await db.close();
    }
  }
}

/**
 * Check if links tables already exist
 */
async function checkTablesExist(): Promise<boolean> {
  const result = await db.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_name IN ('links', 'message_links')
  `);
  
  return result.rows.length > 0;
}

/**
 * Verify tables were created correctly
 */
async function verifyTables(): Promise<void> {
  console.log("🔍 Verifying table creation...");

  // Check links table
  const linksResult = await db.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'links' 
    ORDER BY ordinal_position
  `);

  console.log(`📋 Links table created with ${linksResult.rows.length} columns:`);
  linksResult.rows.slice(0, 5).forEach((row: any) => {
    console.log(`   - ${row.column_name}: ${row.data_type}`);
  });
  
  if (linksResult.rows.length > 5) {
    console.log(`   ... and ${linksResult.rows.length - 5} more columns`);
  }

  // Check message_links table
  const messageLinksResult = await db.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'message_links' 
    ORDER BY ordinal_position
  `);

  console.log(`📋 Message_links table created with ${messageLinksResult.rows.length} columns:`);
  messageLinksResult.rows.forEach((row: any) => {
    console.log(`   - ${row.column_name}: ${row.data_type}`);
  });

  // Check indexes
  const indexResult = await db.query(`
    SELECT indexname 
    FROM pg_indexes 
    WHERE tablename IN ('links', 'message_links')
    ORDER BY indexname
  `);

  console.log(`🗂️  Created ${indexResult.rows.length} indexes:`);
  indexResult.rows.forEach((row: any) => {
    console.log(`   - ${row.indexname}`);
  });

  console.log("✅ Table verification completed!");
}

/**
 * Main function
 */
async function main() {
  console.log("📦 Links Tables Migration Runner");
  console.log("================================");
  
  // Check database connection
  const dbHealthy = await db.healthCheck();
  if (!dbHealthy) {
    console.error("❌ Database health check failed");
    process.exit(1);
  }
  console.log("✅ Database connection verified");

  await runLinksMigration();
  
  console.log("\n🎉 Migration completed successfully!");
  console.log("\nNext steps:");
  console.log("1. Test the new tables with some sample data");
  console.log("2. Implement link extraction service");
  console.log("3. Update the /api/links endpoint");
}

// Run the migration if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error("❌ Unhandled error:", error);
    process.exit(1);
  });
}

export { runLinksMigration };