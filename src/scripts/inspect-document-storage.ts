import { db } from '../lib/database';

interface DocumentInfo {
  id: number;
  document_id: string;
  title: string;
  file_path: string;
  file_size: number;
  total_chunks: number;
  processing_status: string;
  summary: string;
  summary_preview: string;
  created_at: string;
}

interface ChunkInfo {
  id: number;
  content: string;
  document_id: number;
  chunk_index: number;
  chunk_level: number;
  section_title: string;
  hierarchy_level: number;
  chunk_type: string;
  has_tables: boolean;
  has_code: boolean;
  has_links: boolean;
}

async function inspectDocumentStorage() {
  console.log('🔍 Inspecting Document Storage Schema and Data\n');
  
  try {
    // 1. Check if tables exist and get their structure
    await checkTableStructure();
    
    // 2. Get overall statistics
    await getOverallStats();
    
    // 3. Examine document summaries
    await examineDocuments();
    
    // 4. Look at chunk distribution
    await analyzeChunkDistribution();
    
    // 5. Sample some actual data
    await sampleDocumentData();
    
    // 6. Check embeddings
    await checkEmbeddings();
    
    // 7. Verify hierarchical relationships
    await checkHierarchy();
    
  } catch (error) {
    console.error('❌ Error during inspection:', error);
  }
}

async function checkTableStructure() {
  console.log('📋 === TABLE STRUCTURE ===\n');
  
  // Check if tables exist
  const tablesQuery = `
    SELECT table_name, 
           (SELECT count(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
    FROM information_schema.tables t
    WHERE table_schema = 'public' 
    AND table_name IN ('documents', 'document_embeddings')
    ORDER BY table_name;
  `;
  
  const tables = await db.query(tablesQuery);
  console.log('📁 Available document tables:');
  tables.rows.forEach((table: any) => {
    console.log(`  - ${table.table_name} (${table.column_count} columns)`);
  });
  
  // Get detailed column info for documents table
  const documentsColumns = await db.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns 
    WHERE table_name = 'documents' 
    ORDER BY ordinal_position;
  `);
  
  console.log('\n📄 Documents table structure:');
  documentsColumns.rows.forEach((col: any) => {
    console.log(`  - ${col.column_name}: ${col.data_type}${col.is_nullable === 'NO' ? ' NOT NULL' : ''}`);
  });
  
  // Get detailed column info for document_embeddings table
  const embeddingsColumns = await db.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns 
    WHERE table_name = 'document_embeddings' 
    ORDER BY ordinal_position;
  `);
  
  console.log('\n🧠 Document_embeddings table structure:');
  embeddingsColumns.rows.forEach((col: any) => {
    console.log(`  - ${col.column_name}: ${col.data_type}${col.is_nullable === 'NO' ? ' NOT NULL' : ''}`);
  });
  
  // Check indexes
  const indexesQuery = `
    SELECT indexname, tablename, indexdef 
    FROM pg_indexes 
    WHERE tablename IN ('documents', 'document_embeddings')
    AND schemaname = 'public'
    ORDER BY tablename, indexname;
  `;
  
  const indexes = await db.query(indexesQuery);
  console.log('\n📊 Indexes:');
  indexes.rows.forEach((idx: any) => {
    console.log(`  - ${idx.tablename}.${idx.indexname}`);
  });
}

async function getOverallStats() {
  console.log('\n📊 === OVERALL STATISTICS ===\n');
  
  // Documents stats
  const docStats = await db.query(`
    SELECT 
      COUNT(*) as total_documents,
      COUNT(CASE WHEN processing_status = 'completed' THEN 1 END) as completed_docs,
      COUNT(CASE WHEN processing_status = 'failed' THEN 1 END) as failed_docs,
      COUNT(CASE WHEN processing_status = 'pending' THEN 1 END) as pending_docs,
      AVG(total_chunks) as avg_chunks_per_doc,
      AVG(file_size) as avg_file_size,
      SUM(total_chunks) as total_chunks_in_system
    FROM documents;
  `);
  
  const stats = docStats.rows[0];
  console.log('📄 Document Statistics:');
  console.log(`  - Total documents: ${stats.total_documents}`);
  console.log(`  - Completed: ${stats.completed_docs}`);
  console.log(`  - Failed: ${stats.failed_docs}`);
  console.log(`  - Pending: ${stats.pending_docs}`);
  console.log(`  - Average chunks per document: ${Math.round(stats.avg_chunks_per_doc)}`);
  console.log(`  - Average file size: ${Math.round(stats.avg_file_size)} bytes`);
  console.log(`  - Total chunks in system: ${stats.total_chunks_in_system}`);
  
  // Chunks stats
  const chunkStats = await db.query(`
    SELECT 
      COUNT(*) as total_chunks,
      COUNT(CASE WHEN source_type = 'document' THEN 1 END) as document_chunks,
      COUNT(CASE WHEN embedding IS NOT NULL THEN 1 END) as chunks_with_embeddings,
      AVG(LENGTH(content)) as avg_content_length,
      COUNT(CASE WHEN has_code = true THEN 1 END) as chunks_with_code,
      COUNT(CASE WHEN has_tables = true THEN 1 END) as chunks_with_tables,
      COUNT(CASE WHEN has_links = true THEN 1 END) as chunks_with_links
    FROM document_embeddings;
  `);
  
  const chunkStatsData = chunkStats.rows[0];
  console.log('\n🧩 Chunk Statistics:');
  console.log(`  - Total chunks: ${chunkStatsData.total_chunks}`);
  console.log(`  - Document chunks: ${chunkStatsData.document_chunks}`);
  console.log(`  - Chunks with embeddings: ${chunkStatsData.chunks_with_embeddings}`);
  console.log(`  - Average content length: ${Math.round(chunkStatsData.avg_content_length)} characters`);
  console.log(`  - Chunks with code: ${chunkStatsData.chunks_with_code}`);
  console.log(`  - Chunks with tables: ${chunkStatsData.chunks_with_tables}`);
  console.log(`  - Chunks with links: ${chunkStatsData.chunks_with_links}`);
}

async function examineDocuments() {
  console.log('\n📄 === DOCUMENT EXAMPLES ===\n');
  
  // Get a sample of documents with various chunk counts
  const sampleDocs = await db.query(`
    SELECT 
      id, document_id, title, file_path, file_size, total_chunks, 
      processing_status, LEFT(summary, 100) as summary_preview,
      created_at
    FROM documents 
    ORDER BY total_chunks DESC
    LIMIT 10;
  `);
  
  console.log('📚 Top 10 documents by chunk count:');
  sampleDocs.rows.forEach((doc: DocumentInfo, i: number) => {
    console.log(`\n${i + 1}. ${doc.title}`);
    console.log(`   📁 File: ${doc.file_path}`);
    console.log(`   📊 Chunks: ${doc.total_chunks}, Size: ${doc.file_size} bytes`);
    console.log(`   ✅ Status: ${doc.processing_status}`);
    console.log(`   📝 Summary: ${doc.summary_preview}...`);
  });
}

async function analyzeChunkDistribution() {
  console.log('\n📊 === CHUNK DISTRIBUTION ANALYSIS ===\n');
  
  // Chunk level distribution
  const levelDist = await db.query(`
    SELECT 
      chunk_level,
      COUNT(*) as count,
      AVG(LENGTH(content)) as avg_length
    FROM document_embeddings 
    WHERE source_type = 'document'
    GROUP BY chunk_level 
    ORDER BY chunk_level;
  `);
  
  console.log('📈 Chunks by level:');
  levelDist.rows.forEach((level: any) => {
    console.log(`  - Level ${level.chunk_level}: ${level.count} chunks (avg ${Math.round(level.avg_length)} chars)`);
  });
  
  // Chunk type distribution
  const typeDist = await db.query(`
    SELECT 
      chunk_type,
      COUNT(*) as count,
      AVG(LENGTH(content)) as avg_length
    FROM document_embeddings 
    WHERE source_type = 'document'
    GROUP BY chunk_type 
    ORDER BY count DESC;
  `);
  
  console.log('\n📋 Chunks by type:');
  typeDist.rows.forEach((type: any) => {
    console.log(`  - ${type.chunk_type}: ${type.count} chunks (avg ${Math.round(type.avg_length)} chars)`);
  });
  
  // Content length distribution
  const lengthDist = await db.query(`
    SELECT 
      CASE 
        WHEN LENGTH(content) < 200 THEN '< 200 chars'
        WHEN LENGTH(content) < 500 THEN '200-500 chars'
        WHEN LENGTH(content) < 1000 THEN '500-1000 chars'
        WHEN LENGTH(content) < 2000 THEN '1000-2000 chars'
        ELSE '> 2000 chars'
      END as length_bucket,
      COUNT(*) as count
    FROM document_embeddings 
    WHERE source_type = 'document'
    GROUP BY length_bucket
    ORDER BY MIN(LENGTH(content));
  `);
  
  console.log('\n📏 Content length distribution:');
  lengthDist.rows.forEach((bucket: any) => {
    console.log(`  - ${bucket.length_bucket}: ${bucket.count} chunks`);
  });
}

async function sampleDocumentData() {
  console.log('\n🔍 === SAMPLE DATA ===\n');
  
  // Get a sample document with its chunks
  const sampleDoc = await db.query(`
    SELECT id, document_id, title, total_chunks
    FROM documents 
    WHERE total_chunks BETWEEN 5 AND 20
    ORDER BY RANDOM()
    LIMIT 1;
  `);
  
  if (sampleDoc.rows.length === 0) {
    console.log('No suitable sample document found');
    return;
  }
  
  const doc = sampleDoc.rows[0];
  console.log(`📄 Sample Document: "${doc.title}"`);
  console.log(`📊 Total chunks: ${doc.total_chunks}\n`);
  
  // Get its chunks
  const chunks = await db.query(`
    SELECT 
      id, chunk_index, chunk_level, section_title, chunk_type,
      LEFT(content, 150) as content_preview,
      LENGTH(content) as content_length,
      has_code, has_tables, has_links
    FROM document_embeddings 
    WHERE document_id = $1 
    ORDER BY chunk_index;
  `, [doc.id]);
  
  console.log('🧩 Chunks:');
  chunks.rows.forEach((chunk: any, i: number) => {
    console.log(`\n${i + 1}. Chunk ${chunk.chunk_index} (Level ${chunk.chunk_level}, ${chunk.chunk_type})`);
    if (chunk.section_title) {
      console.log(`   📍 Section: ${chunk.section_title}`);
    }
    console.log(`   📝 Preview: ${chunk.content_preview}...`);
    console.log(`   📊 Length: ${chunk.content_length} chars`);
    
    const features = [];
    if (chunk.has_code) features.push('code');
    if (chunk.has_tables) features.push('tables');
    if (chunk.has_links) features.push('links');
    if (features.length > 0) {
      console.log(`   🏷️  Features: ${features.join(', ')}`);
    }
  });
}

async function checkEmbeddings() {
  console.log('\n🧠 === EMBEDDINGS CHECK ===\n');
  
  // Check embedding coverage
  const embeddingStats = await db.query(`
    SELECT 
      COUNT(*) as total_entries,
      COUNT(embedding) as entries_with_embeddings
    FROM document_embeddings de;
  `);
  
  const docEmbeddingStats = await db.query(`
    SELECT COUNT(summary_embedding) as docs_with_summary_embeddings
    FROM documents;
  `);
  
  const embStats = embeddingStats.rows[0];
  const docEmbStats = docEmbeddingStats.rows[0];
  console.log('🎯 Embedding Coverage:');
  console.log(`  - Total entries: ${embStats.total_entries}`);
  console.log(`  - Entries with embeddings: ${embStats.entries_with_embeddings}`);
  console.log(`  - Documents with summary embeddings: ${docEmbStats.docs_with_summary_embeddings}`);
  
  // Check for any missing embeddings
  const missingEmbeddings = await db.query(`
    SELECT COUNT(*) as missing_count
    FROM document_embeddings 
    WHERE embedding IS NULL AND source_type = 'document';
  `);
  
  console.log(`  - Missing embeddings: ${missingEmbeddings.rows[0].missing_count}`);
}

async function checkHierarchy() {
  console.log('\n🌳 === HIERARCHICAL STRUCTURE ===\n');
  
  // Check parent-child relationships
  const hierarchyStats = await db.query(`
    SELECT 
      COUNT(*) as total_chunks,
      COUNT(parent_chunk_id) as chunks_with_parents,
      COUNT(CASE WHEN chunk_level = 0 THEN 1 END) as root_level_chunks,
      COUNT(CASE WHEN chunk_level = 1 THEN 1 END) as level_1_chunks,
      COUNT(CASE WHEN chunk_level = 2 THEN 1 END) as level_2_chunks,
      COUNT(CASE WHEN chunk_level > 2 THEN 1 END) as deeper_level_chunks
    FROM document_embeddings 
    WHERE source_type = 'document';
  `);
  
  const hierStats = hierarchyStats.rows[0];
  console.log('🔗 Hierarchy Statistics:');
  console.log(`  - Total chunks: ${hierStats.total_chunks}`);
  console.log(`  - Chunks with parents: ${hierStats.chunks_with_parents}`);
  console.log(`  - Root level (0): ${hierStats.root_level_chunks}`);
  console.log(`  - Level 1: ${hierStats.level_1_chunks}`);
  console.log(`  - Level 2: ${hierStats.level_2_chunks}`);
  console.log(`  - Deeper levels: ${hierStats.deeper_level_chunks}`);
  
  // Sample hierarchical relationship
  const sampleHierarchy = await db.query(`
    WITH parent_child AS (
      SELECT 
        p.id as parent_id,
        p.section_title as parent_section,
        p.chunk_level as parent_level,
        c.id as child_id,
        c.section_title as child_section,
        c.chunk_level as child_level,
        c.chunk_index as child_index
      FROM document_embeddings p
      JOIN document_embeddings c ON p.id = c.parent_chunk_id
      WHERE p.source_type = 'document'
      ORDER BY p.document_id, c.chunk_index
      LIMIT 5
    )
    SELECT * FROM parent_child;
  `);
  
  if (sampleHierarchy.rows.length > 0) {
    console.log('\n🔍 Sample Parent-Child Relationships:');
    sampleHierarchy.rows.forEach((rel: any, i: number) => {
      console.log(`${i + 1}. Parent (L${rel.parent_level}): "${rel.parent_section}"`);
      console.log(`   └─ Child (L${rel.child_level}): "${rel.child_section}" [chunk ${rel.child_index}]`);
    });
  }
}

// Run the inspection
if (require.main === module) {
  inspectDocumentStorage()
    .then(() => {
      console.log('\n✅ Document storage inspection complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Inspection failed:', error);
      process.exit(1);
    });
}

export { inspectDocumentStorage };