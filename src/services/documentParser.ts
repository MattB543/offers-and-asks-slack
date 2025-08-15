import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { embeddingService } from '../lib/openai';
import { db } from '../lib/database';

export interface DocumentChunk {
  content: string;
  sectionTitle?: string;
  hierarchyLevel: number;
  chunkIndex: number;
  chunkType: 'summary' | 'structural' | 'semantic';
  metadata: {
    hasCode: boolean;
    hasTables: boolean;
    hasLinks: boolean;
    keywords: string[];
    characterCount: number;
    wordCount: number;
  };
}

export interface DocumentParseResult {
  documentId: string;
  title: string;
  summary: string;
  chunks: DocumentChunk[];
  metadata: {
    originalFilePath?: string;
    fileSize: number;
    totalChunks: number;
    processingTime: number;
  };
}

export class DocumentParsingService {
  private static readonly MAX_CHUNK_SIZE = 512;
  private static readonly OVERLAP_SIZE = 50;
  private static readonly LARGE_SECTION_THRESHOLD = 1500;

  /**
   * Parse and process a markdown document from the drive_docs folder
   */
  async parseDocument(filePath: string): Promise<DocumentParseResult> {
    const startTime = Date.now();
    
    try {
      // Read the file
      const content = await fs.readFile(filePath, 'utf-8');
      const stats = await fs.stat(filePath);
      
      // Extract metadata from the file
      const title = this.extractTitle(content);
      const originalFilePath = this.extractOriginalFilePath(content);
      const documentId = this.generateDocumentId(filePath);
      
      // Generate document summary
      console.log(`📄 Generating summary for document: ${title}`);
      const summary = await this.generateDocumentSummary(content, title);
      
      // Parse into hierarchical chunks
      console.log(`🔍 Parsing document into chunks...`);
      const chunks = await this.parseIntoChunks(content);
      
      const processingTime = Date.now() - startTime;
      
      return {
        documentId,
        title,
        summary,
        chunks,
        metadata: {
          originalFilePath,
          fileSize: stats.size,
          totalChunks: chunks.length,
          processingTime
        }
      };
      
    } catch (error) {
      console.error(`❌ Error parsing document ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Parse content into hierarchical chunks following the plan strategy
   */
  private async parseIntoChunks(content: string): Promise<DocumentChunk[]> {
    const chunks: DocumentChunk[] = [];
    
    // Step 1: Split by markdown headers to get sections
    const sections = this.splitByMarkdownHeaders(content);
    
    let chunkIndex = 0;
    
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      
      if (section.content.trim().length === 0) continue;
      
      // For large sections, do semantic chunking
      if (section.content.length > DocumentParsingService.LARGE_SECTION_THRESHOLD) {
        const semanticChunks = this.semanticSplit(section.content);
        
        for (let j = 0; j < semanticChunks.length; j++) {
          const chunk = semanticChunks[j];
          const chunkWithOverlap = this.addContextualOverlap(
            chunk,
            j > 0 ? semanticChunks[j - 1] : null,
            j < semanticChunks.length - 1 ? semanticChunks[j + 1] : null
          );
          
          chunks.push({
            content: chunkWithOverlap,
            sectionTitle: section.title,
            hierarchyLevel: section.level,
            chunkIndex: chunkIndex++,
            chunkType: 'semantic',
            metadata: this.extractChunkMetadata(chunkWithOverlap)
          });
        }
      } else {
        // Small sections - keep as single structural chunk
        chunks.push({
          content: section.content,
          sectionTitle: section.title,
          hierarchyLevel: section.level,
          chunkIndex: chunkIndex++,
          chunkType: 'structural',
          metadata: this.extractChunkMetadata(section.content)
        });
      }
    }
    
    return chunks;
  }

  /**
   * Split content by markdown headers
   */
  private splitByMarkdownHeaders(content: string): Array<{
    title: string;
    content: string;
    level: number;
  }> {
    const lines = content.split('\n');
    const sections: Array<{ title: string; content: string; level: number }> = [];
    
    let currentSection = { title: '', content: '', level: 0 };
    
    for (const line of lines) {
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      
      if (headerMatch) {
        // Save previous section if it has content
        if (currentSection.content.trim()) {
          sections.push({ ...currentSection });
        }
        
        // Start new section
        const level = headerMatch[1].length;
        const title = headerMatch[2];
        currentSection = { title, content: '', level };
      } else {
        // Add line to current section
        currentSection.content += line + '\n';
      }
    }
    
    // Add the last section
    if (currentSection.content.trim()) {
      sections.push(currentSection);
    }
    
    return sections;
  }

  /**
   * Semantic splitting for large sections
   */
  private semanticSplit(text: string): string[] {
    const sentences = this.splitIntoSentences(text);
    const chunks: string[] = [];
    let currentChunk = '';
    
    for (const sentence of sentences) {
      const potentialChunk = currentChunk + sentence;
      
      if (potentialChunk.length > DocumentParsingService.MAX_CHUNK_SIZE && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk = potentialChunk;
      }
    }
    
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }

  /**
   * Split text into sentences (simple implementation)
   */
  private splitIntoSentences(text: string): string[] {
    // Simple sentence splitting - could be enhanced with NLP library
    return text
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => s + '.');
  }

  /**
   * Add contextual overlap between chunks
   */
  private addContextualOverlap(
    chunk: string,
    prevChunk: string | null,
    nextChunk: string | null
  ): string {
    let result = chunk;
    
    // Add context from previous chunk
    if (prevChunk) {
      const prevWords = prevChunk.split(' ').slice(-DocumentParsingService.OVERLAP_SIZE);
      if (prevWords.length > 0) {
        result = `...${prevWords.join(' ')} ${result}`;
      }
    }
    
    // Add context from next chunk
    if (nextChunk) {
      const nextWords = nextChunk.split(' ').slice(0, DocumentParsingService.OVERLAP_SIZE);
      if (nextWords.length > 0) {
        result = `${result} ${nextWords.join(' ')}...`;
      }
    }
    
    return result;
  }

  /**
   * Extract metadata from a chunk
   */
  private extractChunkMetadata(content: string): DocumentChunk['metadata'] {
    const hasCode = /```|`[^`]+`/.test(content);
    const hasTables = /\|.*\|/.test(content);
    const hasLinks = /\[([^\]]+)\]\(([^)]+)\)/.test(content);
    
    // Simple keyword extraction (could be enhanced)
    const keywords = this.extractKeywords(content);
    
    return {
      hasCode,
      hasTables,
      hasLinks,
      keywords,
      characterCount: content.length,
      wordCount: content.split(/\s+/).length
    };
  }

  /**
   * Extract keywords from content (simple implementation)
   */
  private extractKeywords(content: string): string[] {
    // Remove markdown syntax and common words
    const cleanContent = content
      .replace(/[#*`\[\]()]/g, ' ')
      .toLowerCase();
    
    const words = cleanContent
      .split(/\s+/)
      .filter(word => 
        word.length > 3 && 
        !this.isCommonWord(word) &&
        /^[a-zA-Z]+$/.test(word)
      );
    
    // Get unique words and return top 10
    const uniqueWords = [...new Set(words)];
    return uniqueWords.slice(0, 10);
  }

  /**
   * Check if a word is a common stop word
   */
  private isCommonWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use'
    ]);
    return stopWords.has(word);
  }

  /**
   * Extract title from document content
   */
  private extractTitle(content: string): string {
    const lines = content.split('\n');
    
    // Look for first H1 header
    for (const line of lines) {
      const h1Match = line.match(/^#\s+(.+)$/);
      if (h1Match) {
        return h1Match[1].trim();
      }
    }
    
    // Fallback: use first non-empty line
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('**Original file:**')) {
        return trimmed.replace(/^#+\s*/, '');
      }
    }
    
    return 'Untitled Document';
  }

  /**
   * Extract original file path from document metadata
   */
  private extractOriginalFilePath(content: string): string | undefined {
    const match = content.match(/\*\*Original file:\*\*\s*`([^`]+)`/);
    return match ? match[1] : undefined;
  }

  /**
   * Generate document ID from file path
   */
  private generateDocumentId(filePath: string): string {
    const filename = path.basename(filePath, '.md');
    return crypto.createHash('md5').update(filename).digest('hex').substring(0, 16);
  }

  /**
   * Generate document summary using AI
   */
  private async generateDocumentSummary(content: string, title: string): Promise<string> {
    try {
      // Use OpenAI to generate a concise summary
      const prompt = `Summarize the following document in 2-3 sentences. Focus on the main topics, key insights, and actionable points.

Title: ${title}

Content:
${content.substring(0, 4000)}${content.length > 4000 ? '...' : ''}`;

      // For now, create a simple summary. In a real implementation, 
      // you'd want to use a chat completion model
      const words = content.split(/\s+/).slice(0, 100);
      return `Summary of "${title}": ${words.join(' ')}...`;
      
    } catch (error) {
      console.error('Error generating summary:', error);
      return `Document: ${title}`;
    }
  }

  /**
   * Save parsed document to database
   */
  async saveToDatabase(parseResult: DocumentParseResult, filePath: string): Promise<void> {
    await db.runInTransaction(async (client) => {
      // Generate content hash
      const contentHash = crypto.createHash('sha256')
        .update(JSON.stringify(parseResult))
        .digest('hex');
      
      // Insert document record
      const documentResult = await client.query(`
        INSERT INTO documents (
          document_id, title, file_path, file_size, original_file_path,
          content_hash, total_chunks, processing_status, summary, metadata, keywords
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (document_id) 
        DO UPDATE SET 
          title = EXCLUDED.title,
          content_hash = EXCLUDED.content_hash,
          total_chunks = EXCLUDED.total_chunks,
          processing_status = EXCLUDED.processing_status,
          summary = EXCLUDED.summary,
          metadata = EXCLUDED.metadata,
          keywords = EXCLUDED.keywords,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `, [
        parseResult.documentId,
        parseResult.title,
        filePath,
        parseResult.metadata.fileSize,
        parseResult.metadata.originalFilePath,
        contentHash,
        parseResult.metadata.totalChunks,
        'processing',
        parseResult.summary,
        JSON.stringify(parseResult.metadata),
        parseResult.chunks.flatMap(c => c.metadata.keywords)
      ]);
      
      const documentDbId = documentResult.rows[0].id;
      
      // Delete existing chunks for this document
      await client.query('DELETE FROM document_embeddings WHERE document_id = $1', [documentDbId]);
      
      // Generate and insert embeddings for summary
      console.log('🧠 Generating summary embedding...');
      const summaryEmbedding = await embeddingService.generateEmbedding(parseResult.summary);
      
      await client.query(`
        UPDATE documents 
        SET summary_embedding = $1 
        WHERE id = $2
      `, [JSON.stringify(summaryEmbedding), documentDbId]);
      
      // Generate and insert embeddings for each chunk
      console.log(`🧠 Generating embeddings for ${parseResult.chunks.length} chunks...`);
      
      for (let i = 0; i < parseResult.chunks.length; i++) {
        const chunk = parseResult.chunks[i];
        
        console.log(`  Processing chunk ${i + 1}/${parseResult.chunks.length}...`);
        
        const embedding = await embeddingService.generateEmbedding(chunk.content);
        const chunkHash = crypto.createHash('sha256').update(chunk.content).digest('hex');
        
        await client.query(`
          INSERT INTO document_embeddings (
            content, content_hash, embedding, embedding_model,
            source_type, source_id, document_id, root_document_id,
            chunk_index, chunk_level, total_chunks_in_document,
            section_title, hierarchy_level, chunk_type,
            metadata, keywords, has_tables, has_code, has_links
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        `, [
          chunk.content,
          chunkHash,
          JSON.stringify(embedding),
          'text-embedding-3-small',
          'document',
          parseResult.documentId,
          documentDbId,
          documentDbId,
          chunk.chunkIndex,
          chunk.hierarchyLevel,
          parseResult.metadata.totalChunks,
          chunk.sectionTitle,
          chunk.hierarchyLevel,
          chunk.chunkType,
          JSON.stringify(chunk.metadata),
          chunk.metadata.keywords,
          chunk.metadata.hasTables,
          chunk.metadata.hasCode,
          chunk.metadata.hasLinks
        ]);
      }
      
      // Mark document as completed
      await client.query(`
        UPDATE documents 
        SET processing_status = 'completed', processed_at = CURRENT_TIMESTAMP 
        WHERE id = $1
      `, [documentDbId]);
      
      console.log(`✅ Successfully saved document "${parseResult.title}" with ${parseResult.chunks.length} chunks`);
    });
  }
}

export const documentParsingService = new DocumentParsingService();