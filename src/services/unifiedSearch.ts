import { db } from '../lib/database';
import { embeddingService } from '../lib/openai';
import { hybridSearchService, RankedId } from './hybridSearch';
import { cohereReranker } from './cohereReranker';
import { hybridRetriever } from './hybridRetriever';
import { SEARCH_CONFIG } from '../config/searchConfig';

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  source: 'slack' | 'document';
  metadata: {
    // Common fields
    title?: string;
    created_at: string;
    
    // Slack-specific fields
    channel_name?: string;
    user_name?: string;
    thread_ts?: string;
    
    // Document-specific fields
    document_title?: string;
    section_title?: string;
    chunk_type?: string;
    hierarchy_level?: number;
    file_path?: string;
    has_code?: boolean;
    has_tables?: boolean;
  };
}

export interface UnifiedSearchOptions {
  sources?: Array<'slack' | 'document'>;
  limit?: number;
  includeDocumentSummaries?: boolean;
  rerank?: boolean;
  semanticWeight?: number;
  useAdvancedRetrieval?: boolean;
  enableContextExpansion?: boolean;
  enableRecencyBoost?: boolean;
}

export class UnifiedSearchService {
  /**
   * Search across both Slack messages and Drive documents
   */
  async search(
    query: string, 
    options: UnifiedSearchOptions = {}
  ): Promise<SearchResult[]> {
    const {
      sources = ['slack', 'document'],
      limit = 10,
      includeDocumentSummaries = true,
      rerank = true,
      semanticWeight = SEARCH_CONFIG.hybrid.semanticWeight,
      useAdvancedRetrieval = false,
      enableContextExpansion = true,
      enableRecencyBoost = true
    } = options;

    console.log(`🔍 [UnifiedSearch] Searching for: "${query}"`);
    console.log(`📊 [UnifiedSearch] Sources: ${sources.join(', ')}, limit: ${limit}, advanced: ${useAdvancedRetrieval}`);

    try {
      // Use advanced hybrid retrieval if requested
      if (useAdvancedRetrieval) {
        console.log('🚀 [UnifiedSearch] Using advanced hybrid retrieval...');
        return await hybridRetriever.retrieve(query, {
          sources,
          topK: limit,
          includeDocumentSummaries,
          enableReranking: rerank,
          enableContextExpansion,
          enableRecencyBoost
        });
      }

      // Fall back to legacy simple search
      return await this.legacySearch(query, {
        sources,
        limit,
        includeDocumentSummaries,
        rerank,
        semanticWeight
      });
      
    } catch (error) {
      console.error('❌ [UnifiedSearch] Search failed:', error);
      throw error;
    }
  }

  /**
   * Legacy search method (original implementation)
   */
  private async legacySearch(
    query: string, 
    options: {
      sources: Array<'slack' | 'document'>;
      limit: number;
      includeDocumentSummaries: boolean;
      rerank: boolean;
      semanticWeight: number;
    }
  ): Promise<SearchResult[]> {
    const { sources, limit, includeDocumentSummaries, rerank } = options;

    // Generate query embedding
    const queryEmbedding = await embeddingService.generateEmbedding(query);
    
    // Search each enabled source
    const allResults: SearchResult[] = [];
    
    if (sources.includes('slack')) {
      console.log('💬 Searching Slack messages...');
      const slackResults = await this.searchSlackMessages(queryEmbedding, query, limit * 2);
      allResults.push(...slackResults);
    }
    
    if (sources.includes('document')) {
      console.log('📄 Searching documents...');
      const docResults = await this.searchDocuments(
        queryEmbedding, 
        query, 
        limit * 2,
        includeDocumentSummaries
      );
      allResults.push(...docResults);
    }
    
    // Sort by score and take top results
    let finalResults = allResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 2); // Get more for reranking
    
    // Optional reranking
    if (rerank && finalResults.length > 1) {
      console.log('🎯 Reranking results...');
      finalResults = await this.rerankResults(query, finalResults);
    }
    
    // Final limit
    finalResults = finalResults.slice(0, limit);
    
    console.log(`✅ [UnifiedSearch] Found ${finalResults.length} results`);
    this.logResultsSummary(finalResults);
    
    return finalResults;
  }

  /**
   * Search Slack messages using semantic similarity
   */
  private async searchSlackMessages(
    queryEmbedding: number[],
    query: string,
    limit: number
  ): Promise<SearchResult[]> {
    const result = await db.query(`
      SELECT 
        sm.id,
        sm.text as content,
        sm.channel_name,
        sm.user_name,
        sm.thread_ts,
        sm.created_at,
        sm.embedding <=> $1 as distance
      FROM slack_message sm
      WHERE sm.embedding IS NOT NULL
        AND sm.text IS NOT NULL
        AND length(trim(sm.text)) > 10
      ORDER BY sm.embedding <=> $1
      LIMIT $2
    `, [JSON.stringify(queryEmbedding), limit]);
    
    return result.rows.map((row: any) => ({
      id: `slack_${row.id}`,
      content: row.content,
      score: 1 - row.distance, // Convert distance to similarity score
      source: 'slack' as const,
      metadata: {
        channel_name: row.channel_name,
        user_name: row.user_name,
        thread_ts: row.thread_ts,
        created_at: row.created_at
      }
    }));
  }

  /**
   * Search documents using semantic similarity
   */
  private async searchDocuments(
    queryEmbedding: number[],
    query: string,
    limit: number,
    includeSummaries: boolean = true
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    // Search document chunks
    const chunkResult = await db.query(`
      SELECT 
        de.id,
        de.content,
        de.section_title,
        de.hierarchy_level,
        de.chunk_type,
        de.has_code,
        de.has_tables,
        de.created_at,
        de.embedding <=> $1 as distance,
        d.title as document_title,
        d.file_path
      FROM document_embeddings de
      JOIN documents d ON de.document_id = d.id
      WHERE de.embedding IS NOT NULL
        AND de.source_type = 'document'
        AND length(trim(de.content)) > 20
      ORDER BY de.embedding <=> $1
      LIMIT $2
    `, [JSON.stringify(queryEmbedding), limit]);
    
    results.push(...chunkResult.rows.map((row: any) => ({
      id: `doc_chunk_${row.id}`,
      content: row.content,
      score: 1 - row.distance,
      source: 'document' as const,
      metadata: {
        title: row.document_title,
        document_title: row.document_title,
        section_title: row.section_title,
        chunk_type: row.chunk_type,
        hierarchy_level: row.hierarchy_level,
        file_path: row.file_path,
        has_code: row.has_code,
        has_tables: row.has_tables,
        created_at: row.created_at
      }
    })));
    
    // Optionally include document summaries
    if (includeSummaries) {
      const summaryResult = await db.query(`
        SELECT 
          d.id,
          d.summary as content,
          d.title as document_title,
          d.file_path,
          d.created_at,
          d.summary_embedding <=> $1 as distance
        FROM documents d
        WHERE d.summary_embedding IS NOT NULL
          AND d.processing_status = 'completed'
          AND length(trim(d.summary)) > 20
        ORDER BY d.summary_embedding <=> $1
        LIMIT $2
      `, [JSON.stringify(queryEmbedding), Math.max(3, Math.floor(limit / 3))]);
      
      results.push(...summaryResult.rows.map((row: any) => ({
        id: `doc_summary_${row.id}`,
        content: row.content,
        score: (1 - row.distance) * 0.9, // Slightly lower score for summaries
        source: 'document' as const,
        metadata: {
          title: row.document_title,
          document_title: row.document_title,
          section_title: 'Document Summary',
          chunk_type: 'summary',
          hierarchy_level: 0,
          file_path: row.file_path,
          created_at: row.created_at
        }
      })));
    }
    
    return results;
  }

  /**
   * Rerank results using Cohere reranker
   */
  private async rerankResults(
    query: string,
    results: SearchResult[]
  ): Promise<SearchResult[]> {
    try {
      const rerankedResults = await cohereReranker.intelligentRerank(query, results);
      return rerankedResults;
      
    } catch (error) {
      console.warn('⚠️ Reranking failed, returning original results:', error);
      return results;
    }
  }

  /**
   * Search for specific document by title or content
   */
  async searchDocumentByTitle(title: string): Promise<SearchResult[]> {
    const result = await db.query(`
      SELECT 
        d.id,
        d.summary as content,
        d.title as document_title,
        d.file_path,
        d.created_at
      FROM documents d
      WHERE d.title ILIKE $1
        AND d.processing_status = 'completed'
      ORDER BY d.created_at DESC
      LIMIT 10
    `, [`%${title}%`]);
    
    return result.rows.map((row: any) => ({
      id: `doc_title_${row.id}`,
      content: row.content,
      score: 1.0,
      source: 'document' as const,
      metadata: {
        title: row.document_title,
        document_title: row.document_title,
        section_title: 'Document Summary',
        chunk_type: 'summary',
        file_path: row.file_path,
        created_at: row.created_at
      }
    }));
  }

  /**
   * Get document chunks for a specific document (for context)
   */
  async getDocumentChunks(documentId: string): Promise<SearchResult[]> {
    const result = await db.query(`
      SELECT 
        de.id,
        de.content,
        de.section_title,
        de.hierarchy_level,
        de.chunk_type,
        de.chunk_index,
        de.created_at,
        d.title as document_title,
        d.file_path
      FROM document_embeddings de
      JOIN documents d ON de.document_id = d.id
      WHERE d.document_id = $1
        AND de.source_type = 'document'
      ORDER BY de.chunk_index
    `, [documentId]);
    
    return result.rows.map((row: any) => ({
      id: `doc_chunk_${row.id}`,
      content: row.content,
      score: 1.0,
      source: 'document' as const,
      metadata: {
        title: row.document_title,
        document_title: row.document_title,
        section_title: row.section_title,
        chunk_type: row.chunk_type,
        hierarchy_level: row.hierarchy_level,
        file_path: row.file_path,
        created_at: row.created_at
      }
    }));
  }

  /**
   * Get statistics about the search index
   */
  async getSearchStats(): Promise<{
    totalDocuments: number;
    totalChunks: number;
    totalSlackMessages: number;
    processingStatus: Record<string, number>;
  }> {
    // Get document stats
    const docStats = await db.query(`
      SELECT 
        COUNT(*) as total_documents,
        SUM(total_chunks) as total_chunks,
        processing_status,
        COUNT(*) as count
      FROM documents
      GROUP BY processing_status
    `);
    
    // Get Slack message stats
    const slackStats = await db.query(`
      SELECT COUNT(*) as total_messages
      FROM slack_message
      WHERE embedding IS NOT NULL
    `);
    
    const processingStatus: Record<string, number> = {};
    let totalDocuments = 0;
    let totalChunks = 0;
    
    for (const row of docStats.rows) {
      processingStatus[row.processing_status] = parseInt(row.count);
      totalDocuments += parseInt(row.count);
      if (row.total_chunks) {
        totalChunks += parseInt(row.total_chunks);
      }
    }
    
    return {
      totalDocuments,
      totalChunks,
      totalSlackMessages: parseInt(slackStats.rows[0]?.total_messages || '0'),
      processingStatus
    };
  }

  /**
   * Log a summary of search results for debugging
   */
  private logResultsSummary(results: SearchResult[]): void {
    const sourceCount = results.reduce((acc, r) => {
      acc[r.source] = (acc[r.source] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    console.log(`📊 Results breakdown:`, sourceCount);
    
    if (results.length > 0) {
      const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
      console.log(`📈 Average score: ${avgScore.toFixed(3)}`);
      console.log(`🔝 Top result: ${results[0].source} (${results[0].score.toFixed(3)})`);
    }
  }
}

export const unifiedSearchService = new UnifiedSearchService();