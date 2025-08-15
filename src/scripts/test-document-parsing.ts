import { promises as fs } from 'fs';
import path from 'path';
import { documentParsingService } from '../services/documentParser';

/**
 * Test script to parse a single document without database operations
 * This shows what the document processing pipeline does
 */
async function testDocumentParsing() {
  console.log('🧪 Testing document parsing pipeline...');
  
  try {
    // Get list of markdown files in drive_docs folder
    const driveDocsPath = path.join(process.cwd(), 'data', 'drive_docs');
    console.log(`📁 Looking for documents in: ${driveDocsPath}`);
    
    const files = await fs.readdir(driveDocsPath);
    const markdownFiles = files.filter(file => file.endsWith('.md'));
    
    if (markdownFiles.length === 0) {
      console.log('❌ No markdown files found in data/drive_docs/');
      return;
    }
    
    // Test with the first document
    const testFile = markdownFiles[0];
    const filePath = path.join(driveDocsPath, testFile);
    
    console.log(`\n📄 Testing with: ${testFile}`);
    console.log('===============================================');
    
    // Parse the document (without saving to database)
    const parseResult = await documentParsingService.parseDocument(filePath);
    
    // Display results
    console.log(`\n✅ Document Successfully Parsed!`);
    console.log(`📊 Title: ${parseResult.title}`);
    console.log(`📊 Document ID: ${parseResult.documentId}`);
    console.log(`📊 Total chunks: ${parseResult.chunks.length}`);
    console.log(`📊 File size: ${parseResult.metadata.fileSize} bytes`);
    console.log(`📊 Processing time: ${parseResult.metadata.processingTime}ms`);
    
    if (parseResult.metadata.originalFilePath) {
      console.log(`📊 Original path: ${parseResult.metadata.originalFilePath}`);
    }
    
    console.log(`\n📝 Summary (${parseResult.summary.length} chars):`);
    console.log(parseResult.summary.substring(0, 200) + '...');
    
    console.log(`\n🧩 Chunk breakdown:`);
    const chunkTypes = parseResult.chunks.reduce((acc, chunk) => {
      acc[chunk.chunkType] = (acc[chunk.chunkType] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    Object.entries(chunkTypes).forEach(([type, count]) => {
      console.log(`  - ${type}: ${count} chunks`);
    });
    
    console.log(`\n📄 Sample chunks:`);
    parseResult.chunks.slice(0, 3).forEach((chunk, i) => {
      console.log(`\n  Chunk ${i + 1} (${chunk.chunkType}):`);
      if (chunk.sectionTitle) {
        console.log(`    Section: ${chunk.sectionTitle}`);
      }
      console.log(`    Level: ${chunk.hierarchyLevel}`);
      console.log(`    Keywords: ${chunk.metadata.keywords.join(', ')}`);
      console.log(`    Content: ${chunk.content.substring(0, 150)}...`);
    });
    
    console.log(`\n🎉 Test completed successfully!`);
    console.log(`💡 Run "npm run process-documents" when database is available to process all ${markdownFiles.length} documents`);
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
if (require.main === module) {
  testDocumentParsing().catch(error => {
    console.error('💥 Unhandled error:', error);
    process.exit(1);
  });
}

export { testDocumentParsing };