import { promises as fs } from 'fs';
import path from 'path';
import { documentParsingService } from '../services/documentParser';
import { db } from '../lib/database';
import { errorHandler } from '../utils/errorHandler';

interface ProcessingStats {
  totalFiles: number;
  processed: number;
  skipped: number;
  failed: number;
  startTime: number;
  errors: Array<{ file: string; error: string }>;
}

async function main() {
  console.log('📚 Starting Drive documents processing...');
  
  const stats: ProcessingStats = {
    totalFiles: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    startTime: Date.now(),
    errors: []
  };
  
  try {
    // Check database connection
    console.log('🔍 Checking database connection...');
    const dbHealthy = await db.healthCheck();
    if (!dbHealthy) {
      throw new Error('Database connection failed');
    }
    console.log('✅ Database connection verified');
    
    // Run database migration first
    console.log('🏗️  Running database migration...');
    await runMigration();
    console.log('✅ Database migration completed');
    
    // Get list of markdown files in drive_docs folder
    const driveDocsPath = path.join(process.cwd(), 'data', 'drive_docs');
    console.log(`📁 Looking for documents in: ${driveDocsPath}`);
    
    const files = await fs.readdir(driveDocsPath);
    const markdownFiles = files.filter(file => file.endsWith('.md'));
    
    stats.totalFiles = markdownFiles.length;
    console.log(`📄 Found ${stats.totalFiles} markdown files to process`);
    
    if (stats.totalFiles === 0) {
      console.log('ℹ️  No markdown files found to process');
      return;
    }
    
    // Process each file
    for (let i = 0; i < markdownFiles.length; i++) {
      const filename = markdownFiles[i];
      const filePath = path.join(driveDocsPath, filename);
      
      console.log(`\n📄 Processing file ${i + 1}/${stats.totalFiles}: ${filename}`);
      
      try {
        // Check if document already exists and is up to date
        const shouldSkip = await checkIfShouldSkip(filePath);
        if (shouldSkip) {
          console.log(`⏭️  Skipping ${filename} (already processed and up to date)`);
          stats.skipped++;
          continue;
        }
        
        // Parse the document
        console.log(`🔍 Parsing document: ${filename}`);
        const parseResult = await documentParsingService.parseDocument(filePath);
        
        console.log(`📊 Document parsed: ${parseResult.chunks.length} chunks, ${parseResult.metadata.fileSize} bytes`);
        
        // Save to database
        console.log(`💾 Saving to database...`);
        await documentParsingService.saveToDatabase(parseResult, filePath);
        
        stats.processed++;
        console.log(`✅ Successfully processed: ${filename}`);
        
        // Add a small delay to avoid overwhelming the OpenAI API
        if (i < markdownFiles.length - 1) {
          console.log('⏱️  Waiting 1 second before next document...');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
      } catch (error) {
        console.error(`❌ Error processing ${filename}:`, error);
        stats.failed++;
        stats.errors.push({
          file: filename,
          error: error instanceof Error ? error.message : String(error)
        });
        
        // Continue with next file
        continue;
      }
    }
    
    // Print final statistics
    printFinalStats(stats);
    
  } catch (error) {
    console.error('❌ Critical error during processing:', error);
    await errorHandler.handle(error, 'document_processing');
    process.exit(1);
  }
}

/**
 * Check if we should skip processing this file (already processed and up to date)
 */
async function checkIfShouldSkip(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    const filename = path.basename(filePath, '.md');
    
    // Check if document exists in database
    const result = await db.query(`
      SELECT content_hash, updated_at, processing_status 
      FROM documents 
      WHERE file_path = $1
    `, [filePath]);
    
    if (result.rows.length === 0) {
      return false; // Document doesn't exist, should process
    }
    
    const doc = result.rows[0];
    
    // If processing failed before, try again
    if (doc.processing_status === 'failed') {
      return false;
    }
    
    // If processing is in progress, skip (to avoid conflicts)
    if (doc.processing_status === 'processing') {
      return true;
    }
    
    // If completed, we could add file modification time check here
    // For now, we'll reprocess all completed documents to ensure consistency
    return false;
    
  } catch (error) {
    console.warn(`⚠️  Could not check skip status for ${filePath}:`, error);
    return false; // When in doubt, process
  }
}

/**
 * Run the database migration
 */
async function runMigration(): Promise<void> {
  try {
    const migrationPath = path.join(process.cwd(), 'scripts', 'add-document-storage.sql');
    const migrationSQL = await fs.readFile(migrationPath, 'utf-8');
    
    await db.query(migrationSQL);
    console.log('✅ Database migration executed successfully');
    
  } catch (error) {
    console.error('❌ Database migration failed:', error);
    throw error;
  }
}

/**
 * Print final processing statistics
 */
function printFinalStats(stats: ProcessingStats): void {
  const duration = Date.now() - stats.startTime;
  const durationMinutes = Math.round(duration / 1000 / 60 * 100) / 100;
  
  console.log('\n📊 Processing Complete!');
  console.log('========================');
  console.log(`📁 Total files: ${stats.totalFiles}`);
  console.log(`✅ Processed: ${stats.processed}`);
  console.log(`⏭️  Skipped: ${stats.skipped}`);
  console.log(`❌ Failed: ${stats.failed}`);
  console.log(`⏱️  Total time: ${durationMinutes} minutes`);
  
  if (stats.processed > 0) {
    const avgTimePerDoc = duration / stats.processed / 1000;
    console.log(`⚡ Average time per document: ${Math.round(avgTimePerDoc)} seconds`);
  }
  
  if (stats.errors.length > 0) {
    console.log('\n❌ Errors encountered:');
    stats.errors.forEach(error => {
      console.log(`  - ${error.file}: ${error.error}`);
    });
  }
  
  if (stats.processed > 0) {
    console.log('\n🎉 Documents are now available for search!');
    console.log('💡 You can test the search functionality through the Slack bot');
  }
}

/**
 * Handle command line arguments
 */
function parseArgs(): { forceReprocess: boolean; specificFile?: string } {
  const args = process.argv.slice(2);
  return {
    forceReprocess: args.includes('--force'),
    specificFile: args.find(arg => arg.endsWith('.md'))
  };
}

// Handle command line execution
if (require.main === module) {
  main().catch(error => {
    console.error('💥 Unhandled error:', error);
    process.exit(1);
  });
}

export { main as processDocuments };