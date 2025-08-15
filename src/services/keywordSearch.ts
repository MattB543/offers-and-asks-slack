import { db } from '../lib/database';

export interface KeywordSearchResult {
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

export class KeywordSearchService {
  /**
   * Search using PostgreSQL full-text search across both sources
   */
  async search(
    query: string,
    sources: Array<'slack' | 'document'> = ['slack', 'document'],
    limit: number = 50
  ): Promise<KeywordSearchResult[]> {
    const results: KeywordSearchResult[] = [];
    
    if (sources.includes('slack')) {
      const slackResults = await this.searchSlackMessages(query, Math.floor(limit * 0.6));
      results.push(...slackResults);
    }
    
    if (sources.includes('document')) {
      const docResults = await this.searchDocuments(query, Math.floor(limit * 0.6));
      results.push(...docResults);
    }
    
    // Sort by relevance score and limit
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Search Slack messages using PostgreSQL full-text search
   */
  async searchSlackMessages(query: string, limit: number = 30): Promise<KeywordSearchResult[]> {
    try {
      const result = await db.query(`
        SELECT 
          sm.id,
          sm.text as content,
          sm.user_name,
          sm.channel_name,
          sm.thread_ts,
          sm.created_at,
          ts_rank(sm.ts_vector, plainto_tsquery('english', $1)) as ts_rank
        FROM slack_message sm
        WHERE sm.ts_vector @@ plainto_tsquery('english', $1)
          AND sm.text IS NOT NULL
          AND length(trim(sm.text)) > 10
        ORDER BY ts_rank DESC, sm.created_at DESC
        LIMIT $2
      `, [query, limit]);

      return result.rows.map((row: any) => ({
        id: `slack_${row.id}`,
        content: row.content,
        score: parseFloat(row.ts_rank),
        source: 'slack' as const,
        metadata: {
          channel_name: row.channel_name,
          user_name: row.user_name,
          thread_ts: row.thread_ts,
          created_at: row.created_at
        }
      }));
    } catch (error) {
      console.error('❌ [KeywordSearch] Slack search failed:', error);
      return [];
    }
  }

  /**
   * Search documents using PostgreSQL full-text search
   */
  async searchDocuments(query: string, limit: number = 30): Promise<KeywordSearchResult[]> {
    try {
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
          ts_rank(de.ts_vector, plainto_tsquery('english', $1)) as ts_rank
        FROM document_embeddings de
        JOIN documents d ON de.document_id = d.id
        WHERE de.ts_vector @@ plainto_tsquery('english', $1)
          AND de.content IS NOT NULL
          AND de.source_type = 'document'
          AND length(trim(de.content)) > 20
        ORDER BY ts_rank DESC, de.created_at DESC
        LIMIT $2
      `, [query, limit]);

      return result.rows.map((row: any) => ({
        id: `doc_chunk_${row.id}`,
        content: row.content,
        score: parseFloat(row.ts_rank),
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
    } catch (error) {
      console.error('❌ [KeywordSearch] Document search failed:', error);
      return [];
    }
  }

  /**
   * Search with advanced operators (phrase search, boolean logic)
   */
  async advancedSearch(
    query: string,
    options: {
      sources?: Array<'slack' | 'document'>;
      usePhrase?: boolean;
      requireAll?: boolean;
      exclude?: string[];
      limit?: number;
    } = {}
  ): Promise<KeywordSearchResult[]> {
    const {
      sources = ['slack', 'document'],
      usePhrase = false,
      requireAll = false,
      exclude = [],
      limit = 50
    } = options;

    // Build tsquery based on options
    let tsquery = query;
    
    if (usePhrase) {
      tsquery = `"${query}"`;
    } else if (requireAll) {
      tsquery = query.split(' ').join(' & ');
    }
    
    // Add exclusions
    if (exclude.length > 0) {
      const exclusions = exclude.map(term => `!${term}`).join(' & ');
      tsquery = `(${tsquery}) & ${exclusions}`;
    }

    console.log(`🔍 [KeywordSearch] Advanced query: ${tsquery}`);

    const results: KeywordSearchResult[] = [];
    
    if (sources.includes('slack')) {
      const slackResults = await this.advancedSearchSlack(tsquery, Math.floor(limit * 0.6));
      results.push(...slackResults);
    }
    
    if (sources.includes('document')) {
      const docResults = await this.advancedSearchDocuments(tsquery, Math.floor(limit * 0.6));
      results.push(...docResults);
    }
    
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private async advancedSearchSlack(tsquery: string, limit: number): Promise<KeywordSearchResult[]> {
    try {
      const result = await db.query(`
        SELECT 
          sm.id,
          sm.text as content,
          sm.user_name,
          sm.channel_name,
          sm.thread_ts,
          sm.created_at,
          ts_rank(sm.ts_vector, to_tsquery('english', $1)) as ts_rank
        FROM slack_message sm
        WHERE sm.ts_vector @@ to_tsquery('english', $1)
          AND sm.text IS NOT NULL
        ORDER BY ts_rank DESC, sm.created_at DESC
        LIMIT $2
      `, [tsquery, limit]);

      return result.rows.map((row: any) => ({
        id: `slack_${row.id}`,
        content: row.content,
        score: parseFloat(row.ts_rank),
        source: 'slack' as const,
        metadata: {
          channel_name: row.channel_name,
          user_name: row.user_name,
          thread_ts: row.thread_ts,
          created_at: row.created_at
        }
      }));
    } catch (error) {
      console.error('❌ [KeywordSearch] Advanced Slack search failed:', error);
      return [];
    }
  }

  private async advancedSearchDocuments(tsquery: string, limit: number): Promise<KeywordSearchResult[]> {
    try {
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
          ts_rank(de.ts_vector, to_tsquery('english', $1)) as ts_rank
        FROM document_embeddings de
        JOIN documents d ON de.document_id = d.id
        WHERE de.ts_vector @@ to_tsquery('english', $1)
          AND de.content IS NOT NULL
          AND de.source_type = 'document'
        ORDER BY ts_rank DESC, de.created_at DESC
        LIMIT $2
      `, [tsquery, limit]);

      return result.rows.map((row: any) => ({
        id: `doc_chunk_${row.id}`,
        content: row.content,
        score: parseFloat(row.ts_rank),
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
    } catch (error) {
      console.error('❌ [KeywordSearch] Advanced document search failed:', error);
      return [];
    }
  }

  /**
   * Search for exact phrases in content
   */
  async phraseSearch(
    phrase: string,
    sources: Array<'slack' | 'document'> = ['slack', 'document'],
    limit: number = 30
  ): Promise<KeywordSearchResult[]> {
    return this.advancedSearch(phrase, {
      sources,
      usePhrase: true,
      limit
    });
  }

  /**
   * Get suggestions for search terms based on existing content
   */
  async getSuggestions(
    partial: string,
    source: 'slack' | 'document' | 'both' = 'both',
    limit: number = 10
  ): Promise<string[]> {
    // This could be enhanced with a proper suggestion service
    // For now, return basic word completion based on ts_vector content
    
    try {
      let query = '';
      if (source === 'slack' || source === 'both') {
        query = `
          SELECT DISTINCT regexp_split_to_table(lower(text), '\\s+') as word
          FROM slack_message 
          WHERE lower(text) LIKE $1 
            AND text IS NOT NULL
          LIMIT ${limit}
        `;
      } else {
        query = `
          SELECT DISTINCT regexp_split_to_table(lower(content), '\\s+') as word
          FROM document_embeddings 
          WHERE lower(content) LIKE $1 
            AND content IS NOT NULL
            AND source_type = 'document'
          LIMIT ${limit}
        `;
      }

      const result = await db.query(query, [`%${partial.toLowerCase()}%`]);
      
      return result.rows
        .map((row: any) => row.word)
        .filter((word: string) => word.length > 2 && word.startsWith(partial.toLowerCase()))
        .slice(0, limit);
        
    } catch (error) {
      console.error('❌ [KeywordSearch] Suggestions failed:', error);
      return [];
    }
  }
}

export const keywordSearchService = new KeywordSearchService();