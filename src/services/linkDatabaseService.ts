import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";

/**
 * Link result with metadata and context
 */
export interface LinkResult {
  id: number;
  url: string;
  domain: string;
  title?: string;
  description?: string;
  siteName?: string;
  summary?: string;
  wordCount: number;
  messageCount: number;
  processingStatus: 'pending' | 'processing' | 'completed' | 'failed';
  firstSeenAt: string;
  lastSeenAt: string;
  relevanceScore?: number;
  user_name?: string;     // User who first shared this link
  channel_name?: string;  // Channel where this link was first seen
  slack_message?: string; // Full text of the first message containing this link
  recentMessages?: Array<{
    channelName: string;
    userName: string;
    messageText: string;
    timestamp: string;
  }>;
}

/**
 * Search options for link queries
 */
export interface LinkSearchOptions {
  limit?: number;
  offset?: number;
  status?: 'pending' | 'processing' | 'completed' | 'failed';
  domain?: string;
  channelName?: string;
  minMessageCount?: number;
  includeRecentMessages?: boolean;
  dateRange?: {
    start?: Date;
    end?: Date;
  };
}

/**
 * Database service for link retrieval and search operations
 */
export class LinkDatabaseService {

  /**
   * Check if a URL should be excluded from frontend results
   */
  private shouldExcludeUrl(url: string): boolean {
    const excludedPatterns = [
      'http://meet.google.com',
      'https://meet.google.com',
      'https://grain.com',
      'https://calendar.app.google'
    ];

    return excludedPatterns.some(pattern => url.startsWith(pattern));
  }

  /**
   * Filter out excluded URLs from link results
   */
  private filterExcludedLinks(links: LinkResult[]): LinkResult[] {
    return links.filter(link => !this.shouldExcludeUrl(link.url));
  }

  /**
   * Get links in chronological order (default view)
   */
  async getLinksChronological(options: LinkSearchOptions = {}): Promise<{
    links: LinkResult[];
    total: number;
    hasMore: boolean;
  }> {
    const {
      limit = 50,
      offset = 0,
      status,
      domain,
      channelName,
      minMessageCount,
      includeRecentMessages = false,
      dateRange
    } = options;

    let whereConditions = ['l.processing_status IS NOT NULL'];
    const queryParams: any[] = [];
    let paramCount = 0;

    // Build WHERE clause
    if (status) {
      paramCount++;
      whereConditions.push(`l.processing_status = $${paramCount}`);
      queryParams.push(status);
    }

    if (domain) {
      paramCount++;
      whereConditions.push(`l.domain ILIKE $${paramCount}`);
      queryParams.push(`%${domain}%`);
    }

    if (minMessageCount) {
      paramCount++;
      whereConditions.push(`l.message_count >= $${paramCount}`);
      queryParams.push(minMessageCount);
    }

    if (dateRange?.start) {
      paramCount++;
      whereConditions.push(`l.first_seen_at >= $${paramCount}`);
      queryParams.push(dateRange.start.toISOString());
    }

    if (dateRange?.end) {
      paramCount++;
      whereConditions.push(`l.first_seen_at <= $${paramCount}`);
      queryParams.push(dateRange.end.toISOString());
    }

    // Channel filtering requires a JOIN
    let joinClause = '';
    if (channelName) {
      joinClause = `
        JOIN message_links ml ON l.id = ml.link_id
        JOIN slack_message sm ON ml.message_id::bigint = sm.id
      `;
      paramCount++;
      whereConditions.push(`sm.channel_name = $${paramCount}`);
      queryParams.push(channelName);
    }

    const whereClause = whereConditions.length > 0 
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Main query with user and channel info from first occurrence
    const mainQuery = `
      SELECT DISTINCT
        l.id, l.url, l.domain, l.title, l.description, l.site_name,
        l.summary, l.word_count, l.message_count, l.processing_status,
        l.first_seen_at, l.last_seen_at,
        first_msg.user_name, first_msg.channel_name, first_msg.message_text
      FROM links l
      LEFT JOIN (
        SELECT DISTINCT ON (ml.link_id) 
          ml.link_id,
          sm.user_name,
          sm.channel_name,
          sm.text as message_text
        FROM message_links ml
        JOIN slack_message sm ON ml.message_id::bigint = sm.id
        ORDER BY ml.link_id, sm.created_at ASC
      ) first_msg ON l.id = first_msg.link_id
      ${joinClause}
      ${whereClause}
      ORDER BY l.first_seen_at DESC
      LIMIT $${++paramCount} OFFSET $${++paramCount}
    `;

    queryParams.push(limit, offset);

    // Count query
    const countQuery = `
      SELECT COUNT(DISTINCT l.id) as total
      FROM links l
      ${joinClause}
      ${whereClause}
    `;

    const countParams = queryParams.slice(0, -2); // Remove LIMIT and OFFSET

    // Execute queries
    const [linksResult, countResult] = await Promise.all([
      db.query(mainQuery, queryParams),
      db.query(countQuery, countParams)
    ]);

    let links: LinkResult[] = linksResult.rows.map((row: any) => ({
      id: row.id,
      url: row.url,
      domain: row.domain,
      title: row.title,
      description: row.description,
      siteName: row.site_name,
      summary: row.summary,
      wordCount: row.word_count || 0,
      messageCount: row.message_count || 0,
      processingStatus: row.processing_status,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      user_name: row.user_name,
      channel_name: row.channel_name,
      slack_message: row.message_text
    }));

    // Filter out excluded URLs
    links = this.filterExcludedLinks(links);

    // Optionally include recent messages
    if (includeRecentMessages && links.length > 0) {
      for (const link of links) {
        link.recentMessages = await this.getRecentMessagesForLink(link.id);
      }
    }

    const total = parseInt(countResult.rows[0].total);
    const hasMore = offset + limit < total;

    return { links, total, hasMore };
  }

  /**
   * Search links using semantic similarity on summaries
   */
  async searchLinksSemanticSearch(
    query: string, 
    options: LinkSearchOptions = {}
  ): Promise<{
    links: LinkResult[];
    total: number;
    hasMore: boolean;
  }> {
    if (!query || query.trim().length === 0) {
      return this.getLinksChronological(options);
    }

    const {
      limit = 50,
      offset = 0,
      status,
      domain,
      channelName,
      minMessageCount,
      includeRecentMessages = false
    } = options;

    console.log(`🔍 Performing semantic search for: "${query}"`);

    try {
      // Generate embedding for search query
      const queryEmbedding = await embeddingService.generateEmbedding(query);
      
      let whereConditions = [
        'l.summary_embedding IS NOT NULL',
        'l.processing_status = \'completed\''
      ];
      const queryParams: any[] = [`[${queryEmbedding.join(',')}]`];
      let paramCount = 1;

      // Add filters
      if (status && status !== 'completed') {
        paramCount++;
        whereConditions.push(`l.processing_status = $${paramCount}`);
        queryParams.push(status);
      }

      if (domain) {
        paramCount++;
        whereConditions.push(`l.domain ILIKE $${paramCount}`);
        queryParams.push(`%${domain}%`);
      }

      if (minMessageCount) {
        paramCount++;
        whereConditions.push(`l.message_count >= $${paramCount}`);
        queryParams.push(minMessageCount);
      }

      // Channel filtering
      let joinClause = '';
      if (channelName) {
        joinClause = `
          JOIN message_links ml ON l.id = ml.link_id
          JOIN slack_message sm ON ml.message_id::bigint = sm.id
        `;
        paramCount++;
        whereConditions.push(`sm.channel_name = $${paramCount}`);
        queryParams.push(channelName);
      }

      const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

      // Similarity search query with user and channel info
      const searchQuery = `
        SELECT DISTINCT
          l.id, l.url, l.domain, l.title, l.description, l.site_name,
          l.summary, l.word_count, l.message_count, l.processing_status,
          l.first_seen_at, l.last_seen_at,
          1 - (l.summary_embedding <=> $1::vector) as similarity_score,
          first_msg.user_name, first_msg.channel_name, first_msg.message_text
        FROM links l
        LEFT JOIN (
          SELECT DISTINCT ON (ml.link_id) 
            ml.link_id,
            sm.user_name,
            sm.channel_name,
            sm.text as message_text
          FROM message_links ml
          JOIN slack_message sm ON ml.message_id::bigint = sm.id
          ORDER BY ml.link_id, sm.created_at ASC
        ) first_msg ON l.id = first_msg.link_id
        ${joinClause}
        ${whereClause}
        ORDER BY similarity_score DESC, l.first_seen_at DESC
        LIMIT $${++paramCount} OFFSET $${++paramCount}
      `;

      queryParams.push(limit, offset);

      // Execute search
      const searchResult = await db.query(searchQuery, queryParams);

      let links: LinkResult[] = searchResult.rows.map((row: any) => ({
        id: row.id,
        url: row.url,
        domain: row.domain,
        title: row.title,
        description: row.description,
        siteName: row.site_name,
        summary: row.summary,
        wordCount: row.word_count || 0,
        messageCount: row.message_count || 0,
        processingStatus: row.processing_status,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        relevanceScore: parseFloat(row.similarity_score),
        user_name: row.user_name,
        channel_name: row.channel_name,
        slack_message: row.message_text
      }));

      // Filter out excluded URLs
      links = this.filterExcludedLinks(links);

      // Optionally include recent messages
      if (includeRecentMessages && links.length > 0) {
        for (const link of links) {
          link.recentMessages = await this.getRecentMessagesForLink(link.id);
        }
      }

      // For semantic search, we don't have an easy way to get total count without doing the full search
      // So we approximate: if we got fewer results than requested, we're probably done
      const hasMore = searchResult.rows.length === limit;
      const total = offset + searchResult.rows.length + (hasMore ? 1 : 0);

      console.log(`✅ Found ${links.length} semantically similar links (after filtering)`);

      return { links, total, hasMore };

    } catch (error) {
      console.error('❌ Semantic search failed, falling back to chronological:', error);
      // Fallback to chronological search
      return this.getLinksChronological(options);
    }
  }

  /**
   * Get recent messages that referenced a specific link
   */
  private async getRecentMessagesForLink(linkId: number, limit: number = 3): Promise<Array<{
    channelName: string;
    userName: string;
    messageText: string;
    timestamp: string;
  }>> {
    try {
      const result = await db.query(`
        SELECT DISTINCT
          sm.channel_name,
          sm.user_name,
          sm.text as message_text,
          sm.created_at as timestamp
        FROM message_links ml
        JOIN slack_message sm ON ml.message_id::bigint = sm.id
        WHERE ml.link_id = $1
        ORDER BY sm.created_at DESC
        LIMIT $2
      `, [linkId, limit]);

      return result.rows.map((row: any) => ({
        channelName: row.channel_name,
        userName: row.user_name,
        messageText: row.message_text.length > 200 
          ? row.message_text.substring(0, 200) + '...'
          : row.message_text,
        timestamp: row.timestamp
      }));
    } catch (error) {
      // Handle cases where message_id can't be cast to BIGINT or messages don't exist
      console.warn(`⚠️ Could not fetch recent messages for link ${linkId}:`, error instanceof Error ? error.message : error);
      return [];
    }
  }

  /**
   * Get link by ID with full details
   */
  async getLinkById(linkId: number): Promise<LinkResult | null> {
    const result = await db.query(`
      SELECT 
        l.id, l.url, l.domain, l.title, l.description, l.site_name,
        l.summary, l.word_count, l.message_count, l.processing_status,
        l.first_seen_at, l.last_seen_at, l.error_message,
        first_msg.user_name, first_msg.channel_name, first_msg.message_text
      FROM links l
      LEFT JOIN (
        SELECT DISTINCT ON (ml.link_id) 
          ml.link_id,
          sm.user_name,
          sm.channel_name,
          sm.text as message_text
        FROM message_links ml
        JOIN slack_message sm ON ml.message_id::bigint = sm.id
        ORDER BY ml.link_id, sm.created_at ASC
      ) first_msg ON l.id = first_msg.link_id
      WHERE l.id = $1
    `, [linkId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    const link: LinkResult = {
      id: row.id,
      url: row.url,
      domain: row.domain,
      title: row.title,
      description: row.description,
      siteName: row.site_name,
      summary: row.summary,
      wordCount: row.word_count || 0,
      messageCount: row.message_count || 0,
      processingStatus: row.processing_status,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      user_name: row.user_name,
      channel_name: row.channel_name,
      slack_message: row.message_text
    };

    // Always include recent messages for individual link view
    link.recentMessages = await this.getRecentMessagesForLink(link.id, 5);

    return link;
  }

  /**
   * Get summary statistics for links
   */
  async getLinkStats(): Promise<{
    totalLinks: number;
    completedLinks: number;
    pendingLinks: number;
    failedLinks: number;
    topDomains: Array<{ domain: string; count: number }>;
    recentActivity: number;
  }> {
    const [statsResult, domainsResult, activityResult] = await Promise.all([
      // Overall stats
      db.query(`
        SELECT 
          COUNT(*) as total_links,
          COUNT(*) FILTER (WHERE processing_status = 'completed') as completed_links,
          COUNT(*) FILTER (WHERE processing_status = 'pending') as pending_links,
          COUNT(*) FILTER (WHERE processing_status = 'failed') as failed_links
        FROM links
      `),
      
      // Top domains
      db.query(`
        SELECT domain, COUNT(*) as count
        FROM links
        WHERE processing_status = 'completed'
        GROUP BY domain
        ORDER BY count DESC
        LIMIT 10
      `),
      
      // Recent activity (last 24 hours)
      db.query(`
        SELECT COUNT(*) as recent_activity
        FROM links
        WHERE first_seen_at > NOW() - INTERVAL '24 hours'
      `)
    ]);

    const stats = statsResult.rows[0];

    return {
      totalLinks: parseInt(stats.total_links),
      completedLinks: parseInt(stats.completed_links),
      pendingLinks: parseInt(stats.pending_links),
      failedLinks: parseInt(stats.failed_links),
      topDomains: domainsResult.rows.map((row: any) => ({
        domain: row.domain,
        count: parseInt(row.count)
      })),
      recentActivity: parseInt(activityResult.rows[0].recent_activity)
    };
  }
}

// Export singleton instance
export const linkDatabaseService = new LinkDatabaseService();