import { db } from '../lib/database';
import { embeddingService } from '../lib/openai';
import { hybridSearchService } from './hybridSearch';
import { cohereReranker, SearchResult } from './cohereReranker';
import { keywordSearchService } from './keywordSearch';
import { SEARCH_CONFIG } from '../config/searchConfig';

export interface RetrievalOptions {
  sources?: Array<'slack' | 'document'>;
  topK?: number;
  includeDocumentSummaries?: boolean;
  enableReranking?: boolean;
  enableContextExpansion?: boolean;
  enableRecencyBoost?: boolean;
}

export interface QueryClassification {
  isQuestion: boolean;
  isImplementationQuestion: boolean;
  isDiscussionQuestion: boolean;
  isTemporalQuery: boolean;
  isBroadTopic: boolean;
  isCodeRelated: boolean;
  needsConversationContext: boolean;
  containsTechnicalTerms: boolean;
}

export class HybridRetriever {
  /**
   * Advanced retrieval with multiple strategies following the Unified Retrieval Strategy
   */
  async retrieve(
    query: string,
    options: RetrievalOptions = {}
  ): Promise<SearchResult[]> {
    const {
      sources = ['slack', 'document'],
      topK = 10,
      includeDocumentSummaries = true,
      enableReranking = true,
      enableContextExpansion = true,
      enableRecencyBoost = true
    } = options;

    console.log(`🔍 [HybridRetriever] Starting advanced retrieval for: "${query}"`);
    console.log(`📊 [HybridRetriever] Sources: ${sources.join(', ')}, topK: ${topK}`);

    try {
      // Stage 1: Query Enhancement and Classification
      const enhancedQueries = await this.enhanceQuery(query);
      const queryClassification = this.classifyQuery(query);
      
      console.log(`🧠 [HybridRetriever] Query classification:`, queryClassification);

      // Stage 2: Parallel Multi-Source Retrieval
      const retrievalResults = await this.parallelRetrieval(
        query,
        enhancedQueries,
        queryClassification,
        sources,
        includeDocumentSummaries
      );

      // Stage 3: Result Fusion with RRF
      const fusedResults = await this.reciprocalRankFusion(retrievalResults);

      // Stage 4: Metadata Filtering & Boosting
      const filteredResults = await this.applyMetadataFilters(
        fusedResults,
        query,
        queryClassification,
        enableRecencyBoost
      );

      // Stage 5: Reranking with Cohere
      let rerankedResults = filteredResults;
      if (enableReranking && filteredResults.length > 1) {
        console.log('🎯 [HybridRetriever] Applying intelligent reranking...');
        rerankedResults = await cohereReranker.intelligentRerank(
          query,
          filteredResults.slice(0, topK * 3), // Get 3x for reranking
          topK * 2
        );
      }

      // Stage 6: Diversity and Context Expansion
      console.log(`🔧 [HybridRetriever] Starting post-processing with ${rerankedResults.length} results, enableContextExpansion: ${enableContextExpansion}`);
      const finalResults = await this.postProcessResults(
        rerankedResults,
        query,
        queryClassification,
        enableContextExpansion,
        topK
      );

      console.log(`✅ [HybridRetriever] Retrieved ${finalResults.length} results`);
      this.logResultsBreakdown(finalResults);

      return finalResults;

    } catch (error) {
      console.error('❌ [HybridRetriever] Retrieval failed:', error);
      throw error;
    }
  }

  /**
   * Stage 1: Query Enhancement
   */
  private async enhanceQuery(query: string): Promise<string[]> {
    const queries = [query]; // Start with original query
    
    // Add variations based on query analysis
    const queryLower = query.toLowerCase();
    
    // Add synonym variations for common terms
    if (queryLower.includes('discuss') || queryLower.includes('conversation')) {
      queries.push(query.replace(/discuss|conversation/gi, 'talk'));
    }
    
    if (queryLower.includes('implement') || queryLower.includes('build')) {
      queries.push(query.replace(/implement|build/gi, 'create'));
    }
    
    // Add stemmed version (simple approach)
    if (query.endsWith('ing')) {
      queries.push(query.slice(0, -3)); // Remove 'ing'
    }
    
    return queries;
  }

  /**
   * Stage 2: Parallel Multi-Source Retrieval
   */
  private async parallelRetrieval(
    query: string,
    enhancedQueries: string[],
    classification: QueryClassification,
    sources: Array<'slack' | 'document'>,
    includeDocumentSummaries: boolean
  ): Promise<Record<string, SearchResult[]>> {
    const results: Record<string, SearchResult[]> = {};

    // 2a. Semantic search across all sources
    console.log('🧠 [HybridRetriever] Running semantic search...');
    results['semantic'] = await this.semanticSearch(query, sources, 40);

    // 2b. Keyword/Full-text search
    console.log('🔤 [HybridRetriever] Running keyword search...');
    results['keyword'] = await keywordSearchService.search(query, sources, 40);

    // 2c. Document-level search (for broad questions)
    if (classification.isBroadTopic && sources.includes('document')) {
      console.log('📄 [HybridRetriever] Running document summary search...');
      results['document_summary'] = await this.searchDocumentSummaries(query, 10);
    }

    // 2d. Conversation thread search (for Slack)
    if (classification.needsConversationContext && sources.includes('slack')) {
      console.log('💬 [HybridRetriever] Running conversation thread search...');
      results['conversations'] = await this.searchSlackThreads(query, 20);
    }

    // 2e. Enhanced query variations
    if (enhancedQueries.length > 1) {
      console.log('🔄 [HybridRetriever] Running enhanced query search...');
      for (let i = 1; i < enhancedQueries.length; i++) {
        const enhancedResults = await this.semanticSearch(enhancedQueries[i], sources, 20);
        results[`enhanced_${i}`] = enhancedResults;
      }
    }

    return results;
  }

  /**
   * Semantic search using vector similarity
   */
  private async semanticSearch(
    query: string,
    sources: Array<'slack' | 'document'>,
    limit: number
  ): Promise<SearchResult[]> {
    const queryEmbedding = await embeddingService.generateEmbedding(query);
    const results: SearchResult[] = [];

    if (sources.includes('slack')) {
      const slackResults = await this.searchSlackSemantic(queryEmbedding, limit);
      results.push(...slackResults);
    }

    if (sources.includes('document')) {
      const docResults = await this.searchDocumentsSemantic(queryEmbedding, limit);
      results.push(...docResults);
    }

    return results.sort((a, b) => b.score - a.score);
  }

  private async searchSlackSemantic(embedding: number[], limit: number): Promise<SearchResult[]> {
    const result = await db.query(`
      SELECT 
        sm.id,
        sm.text as content,
        sm.channel_name,
        sm.user_name,
        sm.thread_ts,
        sm.created_at,
        (sm.embedding <=> $1) as distance
      FROM slack_message sm
      WHERE sm.embedding IS NOT NULL
        AND sm.text IS NOT NULL
        AND length(trim(sm.text)) > 10
        AND sm.user_id != 'U09934RTP4J'  -- Filter out summary bot
      ORDER BY (sm.embedding <=> $1)
      LIMIT $2
    `, [JSON.stringify(embedding), limit]);

    return result.rows.map((row: any) => ({
      id: `slack_${row.id}`,
      content: row.content,
      score: this.calculateRecencyScore(row.created_at) * (1 - row.distance),
      source: 'slack' as const,
      metadata: {
        channel_name: row.channel_name,
        user_name: row.user_name,
        thread_ts: row.thread_ts,
        created_at: row.created_at
      }
    }));
  }

  private async searchDocumentsSemantic(embedding: number[], limit: number): Promise<SearchResult[]> {
    const result = await db.query(`
      SELECT 
        de.id,
        de.content,
        de.section_title,
        de.hierarchy_level,
        de.chunk_type,
        de.has_code,
        de.has_tables,
        de.created_at,
        d.title as document_title,
        d.file_path,
        (de.embedding <=> $1) as distance
      FROM document_embeddings de
      JOIN documents d ON de.document_id = d.id
      WHERE de.embedding IS NOT NULL
        AND de.source_type = 'document'
        AND length(trim(de.content)) > 20
      ORDER BY (de.embedding <=> $1)
      LIMIT $2
    `, [JSON.stringify(embedding), limit]);

    return result.rows.map((row: any) => ({
      id: `doc_chunk_${row.id}`,
      content: row.content,
      score: (1 - row.distance) * (row.chunk_level <= 2 ? 1.05 : 1.0),
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
    }));
  }

  /**
   * Search document summaries for broad queries
   */
  private async searchDocumentSummaries(query: string, limit: number): Promise<SearchResult[]> {
    const queryEmbedding = await embeddingService.generateEmbedding(query);

    const result = await db.query(`
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
    `, [JSON.stringify(queryEmbedding), limit]);

    return result.rows.map((row: any) => ({
      id: `doc_summary_${row.id}`,
      content: row.content,
      score: (1 - row.distance) * 0.8, // Slightly lower base score for summaries
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
    }));
  }

  /**
   * Search Slack threads for conversation context
   */
  private async searchSlackThreads(query: string, limit: number): Promise<SearchResult[]> {
    const queryEmbedding = await embeddingService.generateEmbedding(query);

    // Find thread starter messages that are relevant
    const result = await db.query(`
      SELECT DISTINCT
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
        AND (sm.thread_ts IS NULL OR sm.ts = sm.thread_ts) -- Thread starters only
        AND length(trim(sm.text)) > 20
        AND sm.user_id != 'U09934RTP4J'  -- Filter out summary bot
      ORDER BY sm.embedding <=> $1
      LIMIT $2
    `, [JSON.stringify(queryEmbedding), limit]);

    return result.rows.map((row: any) => ({
      id: `slack_thread_${row.id}`,
      content: row.content,
      score: (1 - row.distance) * 1.1, // Boost thread starters
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
   * Stage 3: Reciprocal Rank Fusion
   */
  private async reciprocalRankFusion(
    resultSets: Record<string, SearchResult[]>
  ): Promise<SearchResult[]> {
    const rrfScores = new Map<string, { result: SearchResult; score: number }>();
    const k = SEARCH_CONFIG.hybrid.rrfK;

    for (const [resultType, results] of Object.entries(resultSets)) {
      const weight = this.getResultTypeWeight(resultType);
      
      for (let rank = 0; rank < results.length; rank++) {
        const result = results[rank];
        const rrfScore = weight / (k + rank + 1);
        
        if (rrfScores.has(result.id)) {
          const existing = rrfScores.get(result.id)!;
          existing.score += rrfScore;
        } else {
          rrfScores.set(result.id, { result, score: rrfScore });
        }
      }
    }

    return Array.from(rrfScores.values())
      .sort((a, b) => b.score - a.score)
      .map(item => ({ ...item.result, score: item.score }));
  }

  private getResultTypeWeight(resultType: string): number {
    const weights: Record<string, number> = {
      'semantic': 0.4,
      'keyword': 0.3,
      'document_summary': 0.15,
      'conversations': 0.1,
      'enhanced_1': 0.05
    };
    return weights[resultType] || 0.05;
  }

  /**
   * Stage 4: Metadata Filtering & Boosting
   */
  private async applyMetadataFilters(
    results: SearchResult[],
    query: string,
    classification: QueryClassification,
    enableRecencyBoost: boolean
  ): Promise<SearchResult[]> {
    return results.map(result => {
      let boostedScore = result.score;

      // Recency boost
      if (enableRecencyBoost) {
        boostedScore *= this.calculateRecencyScore(result.metadata.created_at);
      }

      // Quality signals
      boostedScore *= this.extractQualitySignals(result);

      // Source preference based on query type
      boostedScore *= this.getSourceWeight(result.source, classification);

      return {
        ...result,
        score: boostedScore
      };
    }).sort((a, b) => b.score - a.score);
  }

  private calculateRecencyScore(createdAt: string): number {
    const now = new Date();
    const created = new Date(createdAt);
    const daysDiff = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);

    if (daysDiff <= 7) return 1.2;
    if (daysDiff <= 30) return 1.1;
    if (daysDiff <= 90) return 1.0;
    return 0.9;
  }

  private extractQualitySignals(result: SearchResult): number {
    let qualityScore = 1.0;

    // Boost longer, more substantial content
    if (result.content.length > 500) qualityScore *= 1.1;
    if (result.content.length > 1000) qualityScore *= 1.1;

    // Boost content with code or tables (for technical queries)
    if (result.metadata.has_code) qualityScore *= 1.05;
    if (result.metadata.has_tables) qualityScore *= 1.05;

    // Boost thread starters vs replies
    if (result.source === 'slack' && !result.metadata.thread_ts) {
      qualityScore *= 1.1;
    }

    return qualityScore;
  }

  private getSourceWeight(source: string, classification: QueryClassification): number {
    if (classification.isImplementationQuestion || classification.isCodeRelated) {
      return source === 'document' ? 1.2 : 0.9;
    }
    
    if (classification.isDiscussionQuestion || classification.isTemporalQuery) {
      return source === 'slack' ? 1.2 : 0.9;
    }
    
    return 1.0; // Balanced
  }

  /**
   * Stage 6: Post-processing with diversity and context expansion
   */
  private async postProcessResults(
    results: SearchResult[],
    query: string,
    classification: QueryClassification,
    enableContextExpansion: boolean,
    finalK: number
  ): Promise<SearchResult[]> {
    let processedResults = results;

    // Sort purely by relevance score (no artificial source balancing)
    processedResults = processedResults.sort((a, b) => b.score - a.score);

    // Context expansion if enabled
    console.log(`🔧 [PostProcess] enableContextExpansion: ${enableContextExpansion}`);
    if (enableContextExpansion) {
      console.log(`🔧 [PostProcess] Starting context expansion...`);
      processedResults = await this.expandContext(processedResults, query);
    } else {
      console.log(`🔧 [PostProcess] Context expansion disabled, skipping...`);
    }

    return processedResults.slice(0, finalK);
  }

  // Removed ensureSourceDiversity - now using pure relevance ranking

  private async expandContext(results: SearchResult[], query: string): Promise<SearchResult[]> {
    console.log(`🔧 [ExpandContext] Called with ${results.length} results for query: "${query}"`);
    // Expand document chunks into full documents with highlighting
    return await this.expandDocumentResults(results);
  }

  /**
   * Transform individual document chunks into full documents with highlighting info
   */
  private async expandDocumentResults(results: SearchResult[]): Promise<SearchResult[]> {
    const documentChunks = results.filter(r => r.source === 'document');
    const slackResults = results.filter(r => r.source === 'slack');
    
    console.log(`🔧 [DocumentExpansion] Processing ${results.length} results: ${documentChunks.length} docs, ${slackResults.length} slack`);
    
    if (documentChunks.length === 0) {
      console.log(`🔧 [DocumentExpansion] No documents to expand, returning original results`);
      return results; // No documents to expand
    }

    // Group chunks by document
    const documentGroups = new Map<string, {
      chunks: SearchResult[];
      documentId: string;
      documentTitle: string;
      filePath: string;
    }>();

    for (const chunk of documentChunks) {
      // Extract document ID from chunk ID (format: doc_chunk_123)
      const chunkId = chunk.id.replace('doc_chunk_', '');
      
      // Get document info from chunk metadata
      const documentKey = chunk.metadata.document_title + '|' + chunk.metadata.file_path;
      
      if (!documentGroups.has(documentKey)) {
        documentGroups.set(documentKey, {
          chunks: [],
          documentId: '', // We'll get this from the database
          documentTitle: chunk.metadata.document_title || '',
          filePath: chunk.metadata.file_path || ''
        });
      }
      
      documentGroups.get(documentKey)!.chunks.push(chunk);
    }

    const expandedDocuments: SearchResult[] = [];

    // For each document group, fetch all chunks and create full document result
    console.log(`🔧 [DocumentExpansion] Created ${documentGroups.size} document groups`);
    
    for (const [documentKey, group] of documentGroups) {
      try {
        console.log(`🔧 [DocumentExpansion] Processing document: ${documentKey} with ${group.chunks.length} chunks`);
        
        // Get all chunks for this document, ordered by hierarchy
        const allChunksResult = await db.query(`
          SELECT 
            de.id,
            de.content,
            de.section_title,
            de.hierarchy_level,
            de.chunk_type,
            de.has_code,
            de.has_tables,
            d.id as document_id,
            d.title as document_title,
            d.file_path
          FROM document_embeddings de
          JOIN documents d ON de.document_id = d.id
          WHERE d.title = $1 
            AND d.file_path = $2
            AND de.source_type = 'document'
            AND length(trim(de.content)) > 10
          ORDER BY de.hierarchy_level ASC, de.id ASC
        `, [group.documentTitle, group.filePath]);

        if (allChunksResult.rows.length === 0) continue;

        const allChunks = allChunksResult.rows;
        const documentId = allChunks[0].document_id;
        const highlightedChunkIds = new Set(
          group.chunks.map(c => c.id.replace('doc_chunk_', ''))
        );

        // Find the highest scoring chunk to use as the primary result
        const primaryChunk = group.chunks.reduce((best, current) => 
          current.score > best.score ? current : best
        );

        // Create chunks array with highlighting info
        const chunks = allChunks.map((chunk: any, index: number) => ({
          id: `chunk_${chunk.id}`,
          content: chunk.content,
          order: index + 1,
          is_highlighted: highlightedChunkIds.has(chunk.id.toString()),
          section_title: chunk.section_title,
          hierarchy_level: chunk.hierarchy_level,
          chunk_type: chunk.chunk_type,
          has_code: chunk.has_code,
          has_tables: chunk.has_tables,
          score: highlightedChunkIds.has(chunk.id.toString()) ? 
            group.chunks.find(c => c.id === `doc_chunk_${chunk.id}`)?.score || 0 : 0
        }));

        // Create full document result
        const documentResult: SearchResult = {
          id: `doc_${documentId}`,
          content: chunks.map((c: any) => c.content).join('\n\n'), // Full document content
          score: primaryChunk.score,
          source: 'document' as const,
          metadata: {
            title: group.documentTitle,
            document_title: group.documentTitle,
            file_path: group.filePath,
            total_chunks: chunks.length,
            highlighted_chunks: chunks.filter((c: any) => c.is_highlighted).length,
            primary_chunk_id: primaryChunk.id.replace('doc_chunk_', ''),
            created_at: primaryChunk.metadata.created_at,
            // Add chunks array for FE reconstruction
            chunks: chunks
          }
        };

        expandedDocuments.push(documentResult);

      } catch (error) {
        console.error(`❌ Failed to expand document: ${documentKey}`, error);
        // Fallback to original chunk results
        expandedDocuments.push(...group.chunks);
      }
    }

    // Combine expanded documents with Slack results and sort by score
    const combinedResults = [...expandedDocuments, ...slackResults];
    return combinedResults.sort((a, b) => b.score - a.score);
  }

  /**
   * Query classification for strategy selection
   */
  private classifyQuery(query: string): QueryClassification {
    const queryLower = query.toLowerCase();
    
    return {
      isQuestion: /\?(.*)?|^(what|how|when|where|why|who|which|can|could|would|should|is|are|do|does|did)\b/.test(queryLower),
      isImplementationQuestion: /\b(how to|implement|build|create|setup|configure|install|code|function|class|method)\b/.test(queryLower),
      isDiscussionQuestion: /\b(discuss|conversation|talk|said|mentioned|decided|opinion|think|feel|agree|disagree)\b/.test(queryLower),
      isTemporalQuery: /\b(yesterday|today|last week|recently|when|latest|recent|now|current|ago)\b/.test(queryLower),
      isBroadTopic: /\b(tell me about|what is|explain|overview|summary|introduction)\b/.test(queryLower),
      isCodeRelated: /\b(bug|error|fix|debug|test|api|database|function|variable|class|github|code)\b/.test(queryLower),
      needsConversationContext: /\b(discuss|conversation|thread|decided|conclusion|consensus|meeting)\b/.test(queryLower),
      containsTechnicalTerms: /\b(api|database|server|client|framework|library|algorithm|model|deployment)\b/.test(queryLower)
    };
  }

  private logResultsBreakdown(results: SearchResult[]): void {
    const sourceCount = results.reduce((acc, r) => {
      acc[r.source] = (acc[r.source] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    console.log(`📊 [HybridRetriever] Results breakdown:`, sourceCount);
    
    if (results.length > 0) {
      const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
      console.log(`📈 [HybridRetriever] Average score: ${avgScore.toFixed(3)}`);
      console.log(`🔝 [HybridRetriever] Top result: ${results[0].source} (${results[0].score.toFixed(3)})`);
    }
  }
}

export const hybridRetriever = new HybridRetriever();