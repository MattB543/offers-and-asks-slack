import { db } from "../lib/database";

/**
 * Extracted link data with position and context
 */
interface ExtractedLink {
  originalUrl: string;
  cleanUrl: string;
  position: number;
  context: string;
  domain: string;
}

/**
 * Service for extracting and managing links from Slack messages
 */
export class LinkExtractionService {
  
  /**
   * Extract all links from a Slack message text
   */
  async extractLinksFromMessage(messageText: string): Promise<ExtractedLink[]> {
    if (!messageText || messageText.length === 0) {
      return [];
    }

    const links: ExtractedLink[] = [];
    
    // Enhanced regex to catch various URL formats including Slack's pipe formatting
    const urlRegex = /<?(https?:\/\/[^\s<>|]+)(\|[^>]+)?>?/g;
    let match;

    while ((match = urlRegex.exec(messageText)) !== null) {
      const originalUrl = match[0]; // Full match with brackets/formatting
      const cleanUrl = this.cleanSlackUrl(match[1]); // Just the URL part
      const position = match.index;
      
      // Skip if URL is invalid or filtered out
      if (!this.isValidUrl(cleanUrl)) {
        continue;
      }

      // Extract surrounding context (±100 characters)
      const contextStart = Math.max(0, position - 100);
      const contextEnd = Math.min(messageText.length, position + originalUrl.length + 100);
      const context = messageText.substring(contextStart, contextEnd).trim();

      const domain = this.extractDomain(cleanUrl);
      
      links.push({
        originalUrl,
        cleanUrl,
        position,
        context,
        domain
      });
    }

    return links;
  }

  /**
   * Process links from a Slack message and store in database
   */
  async processMessageLinks(
    messageId: string, 
    messageText: string, 
    channelName: string,
    userName: string,
    messageTimestamp?: string
  ): Promise<number> {
    const extractedLinks = await this.extractLinksFromMessage(messageText);
    
    if (extractedLinks.length === 0) {
      return 0;
    }

    console.log(`🔗 Found ${extractedLinks.length} links in message from #${channelName}`);

    for (const linkData of extractedLinks) {
      try {
        await this.registerLink(linkData, messageId, channelName, userName, messageTimestamp);
      } catch (error) {
        console.error(`❌ Failed to register link ${linkData.cleanUrl}:`, error);
        // Continue processing other links even if one fails
      }
    }

    return extractedLinks.length;
  }

  /**
   * Register a link in the database and create message relationship
   */
  private async registerLink(
    linkData: ExtractedLink, 
    messageId: string,
    channelName: string,
    userName: string,
    messageTimestamp?: string
  ): Promise<void> {
    await db.query('BEGIN');
    
    try {
      // Check if link already exists
      let linkResult = await db.query(
        'SELECT id FROM links WHERE url = $1',
        [linkData.cleanUrl]
      );

      let linkId: number;

      if (linkResult.rows.length === 0) {
        // Create new link record
        const firstSeenAt = messageTimestamp 
          ? `to_timestamp(${parseFloat(messageTimestamp)})`
          : 'NOW()';
        const lastSeenAt = messageTimestamp 
          ? `to_timestamp(${parseFloat(messageTimestamp)})`
          : 'NOW()';
        
        linkResult = await db.query(`
          INSERT INTO links (
            url, original_url, domain, processing_status, 
            message_count, first_seen_at, last_seen_at
          ) 
          VALUES ($1, $2, $3, $4, 1, ${firstSeenAt}, ${lastSeenAt})
          RETURNING id
        `, [
          linkData.cleanUrl,
          linkData.originalUrl,
          linkData.domain,
          'pending'
        ]);
        
        linkId = linkResult.rows[0].id;
        console.log(`  ✅ Created new link ${linkId}: ${linkData.domain}`);
      } else {
        linkId = linkResult.rows[0].id;
        
        // Update existing link (increment message count, update last seen)
        const lastSeenAt = messageTimestamp 
          ? `to_timestamp(${parseFloat(messageTimestamp)})`
          : 'NOW()';
          
        await db.query(`
          UPDATE links 
          SET message_count = message_count + 1, 
              last_seen_at = ${lastSeenAt},
              updated_at = NOW()
          WHERE id = $1
        `, [linkId]);
        
        console.log(`  📈 Updated existing link ${linkId}: ${linkData.domain}`);
      }

      // Create message-link relationship (ignore if already exists)
      await db.query(`
        INSERT INTO message_links (message_id, link_id, position, context)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (message_id, link_id) DO NOTHING
      `, [messageId, linkId, linkData.position, linkData.context]);

      await db.query('COMMIT');
      
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }

  /**
   * Clean Slack URL formatting (handles <url|display_text> format)
   */
  private cleanSlackUrl(rawUrl: string): string {
    // Remove angle brackets
    rawUrl = rawUrl.replace(/^<|>$/g, '');
    
    // Handle pipe formatting: <url|display_text> -> url
    if (rawUrl.includes('|')) {
      rawUrl = rawUrl.split('|')[0];
    }
    
    // Ensure protocol exists
    if (!rawUrl.match(/^https?:\/\//)) {
      if (rawUrl.includes('.') && rawUrl.length > 4) {
        rawUrl = 'https://' + rawUrl;
      }
    }
    
    return rawUrl;
  }

  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, ''); // Remove www prefix
    } catch {
      // Fallback for malformed URLs
      const match = url.match(/https?:\/\/([^\/\s]+)/);
      return match ? match[1].replace(/^www\./, '') : 'unknown';
    }
  }

  /**
   * Validate if URL should be processed
   */
  private isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      
      // Filter out unwanted domains/patterns
      const hostname = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase();
      
      // Skip internal/local URLs
      if (hostname.includes('localhost') || 
          hostname.includes('127.0.0.1') ||
          hostname.includes('192.168.') ||
          hostname.includes('10.0.')) {
        return false;
      }
      
      // Skip Slack internal URLs
      if (hostname.includes('slack.com') || 
          hostname.includes('slack-files.com')) {
        return false;
      }
      
      // Skip file extensions we don't want to process
      if (path.match(/\.(jpg|jpeg|png|gif|bmp|webp|svg|ico|pdf|zip|exe|dmg|rar|7z)$/i)) {
        return false;
      }
      
      // Skip obvious tracking/analytics URLs
      if (hostname.includes('google-analytics.com') ||
          hostname.includes('facebook.com/tr') ||
          hostname.includes('doubleclick.net')) {
        return false;
      }
      
      // Must have a valid TLD
      if (!hostname.includes('.') || hostname.length < 4) {
        return false;
      }
      
      return true;
      
    } catch {
      return false;
    }
  }

  /**
   * Get links for a specific channel (for debugging/admin)
   */
  async getLinksForChannel(channelName: string, limit: number = 20): Promise<any[]> {
    const result = await db.query(`
      SELECT DISTINCT
        l.id, l.url, l.domain, l.title, l.summary, 
        l.processing_status, l.message_count, l.first_seen_at,
        COUNT(DISTINCT ml.message_id) as message_references
      FROM links l
      JOIN message_links ml ON l.id = ml.link_id
      JOIN slack_message m ON ml.message_id::bigint = m.id
      WHERE m.channel_name = $1
      GROUP BY l.id, l.url, l.domain, l.title, l.summary, 
               l.processing_status, l.message_count, l.first_seen_at
      ORDER BY l.first_seen_at DESC
      LIMIT $2
    `, [channelName, limit]);

    return result.rows;
  }

  /**
   * Get processing queue statistics
   */
  async getProcessingStats(): Promise<{
    totalLinks: number;
    pendingLinks: number;
    completedLinks: number;
    failedLinks: number;
    processingRate: number;
  }> {
    const statsResult = await db.query(`
      SELECT 
        COUNT(*) as total_links,
        COUNT(*) FILTER (WHERE processing_status = 'pending') as pending_links,
        COUNT(*) FILTER (WHERE processing_status = 'completed') as completed_links,
        COUNT(*) FILTER (WHERE processing_status = 'failed') as failed_links
      FROM links
    `);

    const rateResult = await db.query(`
      SELECT COUNT(*) as recent_processed
      FROM links 
      WHERE processing_status = 'completed' 
        AND updated_at > NOW() - INTERVAL '1 hour'
    `);

    const stats = statsResult.rows[0];
    const processingRate = rateResult.rows[0].recent_processed;

    return {
      totalLinks: parseInt(stats.total_links),
      pendingLinks: parseInt(stats.pending_links),
      completedLinks: parseInt(stats.completed_links),
      failedLinks: parseInt(stats.failed_links),
      processingRate: parseInt(processingRate)
    };
  }
}

// Export singleton instance
export const linkExtractionService = new LinkExtractionService();