import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";
import axios from "axios";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

// Type definitions for unfurl (no official types available)
const unfurl = require("unfurl");
interface UnfurlResult {
  title?: string;
  description?: string;
  favicon?: string;
  open_graph?: {
    title?: string;
    description?: string;
    site_name?: string;
    type?: string;
    author?: string;
    published_time?: string;
    images?: Array<{ url: string }>;
  };
  twitter_card?: {
    title?: string;
    description?: string;
    creator?: string;
    images?: Array<{ url: string }>;
  };
}

/**
 * Link metadata extracted from web page
 */
interface LinkMetadata {
  title?: string;
  description?: string;
  siteName?: string;
  author?: string;
  publishedTime?: string;
}

/**
 * Processed link content
 */
interface ProcessedContent {
  metadata: LinkMetadata;
  content?: string;
  markdown?: string;
  summary?: string;
  wordCount?: number;
  processingTimeMs: number;
  error?: string;
}

/**
 * Production service for processing link content
 */
export class LinkProcessingService {
  private turndownService: TurndownService;

  constructor() {

    // Configure Turndown for better markdown conversion
    this.turndownService = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
      strongDelimiter: "**",
      linkStyle: "inlined",
    });

    // Add custom rules for better content preservation
    this.turndownService.addRule("removeStyle", {
      filter: ["style", "script", "noscript"],
      replacement: () => "",
    });
  }

  /**
   * Check if a URL should be skipped for content processing
   * Some domains are known to be uncrawlable or don't provide useful content
   */
  private shouldSkipProcessing(url: string): boolean {
    const uncrawlableDomains = [
      'https://x.com/',
      'https://twitter.com/',
      'http://meet.google.com/',
      'https://meet.google.com/',
      'https://grain.com/',
      'https://calendar.app.google'
    ];

    return uncrawlableDomains.some(domain => url.startsWith(domain));
  }

  /**
   * Process a single link: extract metadata, content, and generate summary
   */
  async processLink(linkId: number): Promise<boolean> {
    const startTime = Date.now();
    
    try {
      // Get link details
      const linkResult = await db.query(
        'SELECT id, url, processing_status FROM links WHERE id = $1',
        [linkId]
      );

      if (linkResult.rows.length === 0) {
        throw new Error(`Link ${linkId} not found`);
      }

      const link = linkResult.rows[0];
      if (link.processing_status === 'completed') {
        console.log(`⏭️ Link ${linkId} already processed, skipping`);
        return true;
      }

      console.log(`🔄 Processing link ${linkId}: ${link.url}`);

      // Check if this URL should be skipped for processing
      if (this.shouldSkipProcessing(link.url)) {
        console.log(`⏭️ Skipping processing for ${link.url} - uncrawlable domain`);
        await db.query(
          'UPDATE links SET processing_status = $1, updated_at = NOW() WHERE id = $2',
          ['completed', linkId]
        );
        return true;
      }

      // Mark as processing
      await db.query(
        'UPDATE links SET processing_status = $1, updated_at = NOW() WHERE id = $2',
        ['processing', linkId]
      );

      // Process the content
      const processed = await this.processLinkContent(link.url);

      // Generate embedding for summary if we have one
      let summaryEmbedding = null;
      if (processed.summary) {
        summaryEmbedding = await embeddingService.generateEmbedding(processed.summary);
      }

      // Update database with results
      await db.query(`
        UPDATE links SET
          title = $1,
          description = $2,
          site_name = $3,
          summary = $4,
          word_count = $5,
          processing_status = $6,
          summary_embedding = $7,
          error_message = $8,
          updated_at = NOW()
        WHERE id = $9
      `, [
        processed.metadata.title,
        processed.metadata.description,
        processed.metadata.siteName,
        processed.summary,
        processed.wordCount || 0,
        processed.error ? 'failed' : 'completed',
        summaryEmbedding ? `[${summaryEmbedding.join(',')}]` : null,
        processed.error,
        linkId
      ]);

      const processingTime = Date.now() - startTime;
      console.log(`✅ Link ${linkId} processed successfully in ${processingTime}ms`);
      
      return true;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      console.error(`❌ Failed to process link ${linkId}:`, errorMessage);

      // Mark as failed
      await db.query(`
        UPDATE links SET
          processing_status = 'failed',
          error_message = $1,
          updated_at = NOW()
        WHERE id = $2
      `, [errorMessage, linkId]);

      return false;
    }
  }

  /**
   * Process multiple links in batch
   */
  async processBatch(batchSize: number = 5): Promise<{
    processed: number;
    successful: number;
    failed: number;
  }> {
    console.log(`🔄 Processing batch of ${batchSize} links...`);

    // Get pending links
    const pendingResult = await db.query(`
      SELECT id, url 
      FROM links 
      WHERE processing_status = 'pending'
      ORDER BY first_seen_at ASC
      LIMIT $1
    `, [batchSize]);

    if (pendingResult.rows.length === 0) {
      console.log(`ℹ️ No pending links to process`);
      return { processed: 0, successful: 0, failed: 0 };
    }

    let successful = 0;
    let failed = 0;

    for (const link of pendingResult.rows) {
      const success = await this.processLink(link.id);
      if (success) {
        successful++;
      } else {
        failed++;
      }

      // Add delay between requests to be respectful
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const processed = successful + failed;
    console.log(`📊 Batch complete: ${processed} processed, ${successful} successful, ${failed} failed`);

    return { processed, successful, failed };
  }

  /**
   * Extract metadata and content from a URL
   */
  private async processLinkContent(url: string): Promise<ProcessedContent> {
    const startTime = Date.now();
    const result: ProcessedContent = {
      metadata: {},
      processingTimeMs: 0
    };

    try {
      console.log(`📄 Fetching content from: ${url}`);

      // Step 1: Extract metadata using unfurl
      try {
        const unfurlResult: UnfurlResult = await unfurl(url, {
          timeout: 15000,
          follow: 8,
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0"
        });

        result.metadata = {
          title: unfurlResult.title,
          description: unfurlResult.description,
          siteName: unfurlResult.open_graph?.site_name,
          author: unfurlResult.open_graph?.author || unfurlResult.twitter_card?.creator,
          publishedTime: unfurlResult.open_graph?.published_time
        };

        console.log(`✅ Metadata extracted: ${result.metadata.title || 'No title'}`);
      } catch (error) {
        console.warn(`⚠️ Failed to extract metadata from ${url}:`, error);
      }

      // Step 2: Extract and clean content
      const cleanContent = await this.extractCleanContent(url);
      if (cleanContent.content) {
        result.content = cleanContent.content;
        result.wordCount = cleanContent.wordCount;
        console.log(`✅ Content cleaned: ${result.wordCount} words`);

        // Step 3: Convert to Markdown
        result.markdown = this.convertToMarkdown(cleanContent.content);
        console.log(`✅ Converted to Markdown: ${result.markdown.length} chars`);

        // Step 4: Generate AI summary
        result.summary = await this.summarizeContent(
          result.markdown,
          result.metadata.title || cleanContent.title,
          url
        );
        console.log(`✅ Summary generated: ${result.summary.length} chars`);
      } else {
        console.log(`⚠️ No content extracted from ${url}`);
      }

    } catch (error) {
      console.error(`❌ Error processing content from ${url}:`, error);
      result.error = error instanceof Error ? error.message : String(error);
    }

    result.processingTimeMs = Date.now() - startTime;
    return result;
  }

  /**
   * Fetch and clean HTML content with retry logic
   */
  private async extractCleanContent(url: string): Promise<{
    content?: string;
    title?: string;
    wordCount?: number;
  }> {
    const userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const userAgent = userAgents[attempt % userAgents.length];
        
        const response = await axios.get(url, {
          timeout: 20000,
          headers: {
            "User-Agent": userAgent,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            Connection: "keep-alive",
            "Upgrade-Insecure-Requests": "1",
            "Cache-Control": "no-cache",
          },
          maxRedirects: 8,
          validateStatus: (status) => status >= 200 && status < 500,
        });

        if (!response.data) {
          throw new Error("No content received");
        }

        // Parse with JSDOM and extract using Readability
        const dom = new JSDOM(response.data, { url });
        const document = dom.window.document;

        const reader = new Readability(document, {
          debug: false,
          nbTopCandidates: 5,
          charThreshold: 300,
          classesToPreserve: ["highlight", "code", "pre", "article", "main"],
        });

        const article = reader.parse();

        if (article) {
          const textContent = article.textContent || "";
          const wordCount = textContent.split(/\s+/).filter(word => word.length > 0).length;

          return {
            content: article.content || undefined,
            title: article.title || undefined,
            wordCount,
          };
        }

        // Fallback extraction if Readability fails
        return this.fallbackExtraction(document);

      } catch (error) {
        console.warn(`⚠️ Attempt ${attempt + 1} failed:`, error instanceof Error ? error.message : error);
        
        if (attempt === 1) { // Last attempt
          throw error;
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return {};
  }

  /**
   * Fallback content extraction when Readability fails
   */
  private fallbackExtraction(document: Document): {
    content?: string;
    title?: string;
    wordCount?: number;
  } {
    const selectors = [
      'main', '[role="main"]', '.main', '#main',
      'article', '.article', '#article',
      '.content', '#content', '.post', '.entry',
      'body p'
    ];

    let content = '';
    const title = document.title;

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        content = Array.from(elements)
          .map(el => el.textContent?.trim() || '')
          .filter(text => text.length > 50)
          .join('\n\n');
        
        if (content.length > 200) {
          break;
        }
      }
    }

    if (!content || content.length < 50) {
      throw new Error("No substantial content found");
    }

    const wordCount = content.split(/\s+/).filter(word => word.length > 0).length;

    return {
      content: `<div>${content.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</div>`,
      title,
      wordCount
    };
  }

  /**
   * Convert HTML to Markdown
   */
  private convertToMarkdown(html: string): string {
    try {
      return this.turndownService.turndown(html);
    } catch (error) {
      console.warn("⚠️ Failed to convert HTML to Markdown:", error);
      return html;
    }
  }

  /**
   * Generate AI summary of content
   */
  private async summarizeContent(content: string, title?: string, url?: string): Promise<string> {
    console.log(`🤖 Summarizing content (${content.length} chars)...`);
    return await embeddingService.generateSummary(content, title, url);
  }

  /**
   * Get processing statistics
   */
  async getStats(): Promise<{
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  }> {
    const result = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE processing_status = 'pending') as pending,
        COUNT(*) FILTER (WHERE processing_status = 'processing') as processing,
        COUNT(*) FILTER (WHERE processing_status = 'completed') as completed,
        COUNT(*) FILTER (WHERE processing_status = 'failed') as failed
      FROM links
    `);

    const stats = result.rows[0];
    return {
      pending: parseInt(stats.pending || 0),
      processing: parseInt(stats.processing || 0),
      completed: parseInt(stats.completed || 0),
      failed: parseInt(stats.failed || 0)
    };
  }
}

// Export singleton instance
export const linkProcessingService = new LinkProcessingService();