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
    
    // Document expansion fields (for full document results)
    total_chunks?: number;
    highlighted_chunks?: number;
    primary_chunk_id?: string;
    chunks?: Array<{
      id: string;
      content: string;
      order: number;
      is_highlighted: boolean;
      section_title?: string;
      hierarchy_level?: number;
      chunk_type?: string;
      has_code?: boolean;
      has_tables?: boolean;
      score?: number;
    }>;
  };
}

export class CohereReranker {
  private apiKey = process.env.COHERE_API_KEY;
  private apiUrl = "https://api.cohere.com/v2/rerank";

  /**
   * Rerank search results with source-aware formatting
   */
  async rerank(
    query: string,
    results: SearchResult[],
    topK: number = 20
  ): Promise<Array<[number, number]>> {
    if (!this.apiKey || results.length === 0) {
      return results.map((_, i) => [i, 0]);
    }

    try {
      const documents = results.map(result => this.formatResultForReranking(result));
      
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-Client-Name": "unified-search",
        },
        body: JSON.stringify({
          model: "rerank-v3.5",
          query: query,
          top_n: topK,
          documents: documents,
        }),
      });

      if (!response.ok) {
        console.error("Cohere rerank failed:", response.statusText);
        return results.map((_, i) => [i, 0]);
      }

      const data = await response.json();
      return data.results.map((r: any) => [r.index, r.relevance_score]);
      
    } catch (error) {
      console.error("Rerank error:", error);
      return results.map((_, i) => [i, 0]);
    }
  }

  /**
   * Separate reranking for different source types with optimized formatting
   */
  async rerankBySource(
    query: string,
    results: SearchResult[],
    options: {
      slackWeight?: number;
      documentWeight?: number;
      topKPerSource?: number;
    } = {}
  ): Promise<SearchResult[]> {
    const {
      slackWeight = 0.5,
      documentWeight = 0.5,
      topKPerSource = 30
    } = options;

    // Separate results by source
    const slackResults = results.filter(r => r.source === 'slack');
    const docResults = results.filter(r => r.source === 'document');

    // Rerank each source separately for better accuracy
    const rerankedSlack = slackResults.length > 0 
      ? await this.rerank(query, slackResults, Math.min(topKPerSource, slackResults.length))
      : [];
    
    const rerankedDocs = docResults.length > 0
      ? await this.rerank(query, docResults, Math.min(topKPerSource, docResults.length))
      : [];

    // Merge results with source-specific weights
    const mergedResults: Array<{ result: SearchResult; score: number }> = [];

    rerankedSlack.forEach(([index, score]) => {
      mergedResults.push({
        result: slackResults[index],
        score: score * slackWeight
      });
    });

    rerankedDocs.forEach(([index, score]) => {
      mergedResults.push({
        result: docResults[index],
        score: score * documentWeight
      });
    });

    // Sort by weighted scores and return results
    return mergedResults
      .sort((a, b) => b.score - a.score)
      .map(item => ({ ...item.result, score: item.score }));
  }

  /**
   * Intelligent reranking based on query type
   */
  async intelligentRerank(
    query: string,
    results: SearchResult[],
    topK: number = 20
  ): Promise<SearchResult[]> {
    const queryType = this.classifyQuery(query);
    
    let slackWeight = 0.5;
    let documentWeight = 0.5;

    // Adjust weights based on query type
    if (queryType.isImplementationQuestion) {
      documentWeight = 0.7;
      slackWeight = 0.3;
    } else if (queryType.isDiscussionQuestion) {
      slackWeight = 0.7;
      documentWeight = 0.3;
    } else if (queryType.isTemporalQuery) {
      slackWeight = 0.8;
      documentWeight = 0.2;
    }

    console.log(`🎯 [CohereReranker] Query type weights: Slack=${slackWeight}, Docs=${documentWeight}`);

    // Calculate per-source limit based on total topK requested
    // Allow each source to have up to 60% of total results (with some overlap allowed)
    const maxPerSource = Math.ceil(topK * 0.6);
    
    console.log(`🔧 [CohereReranker] Using maxPerSource: ${maxPerSource} (based on topK: ${topK})`);
    
    return this.rerankBySource(query, results, {
      slackWeight,
      documentWeight,
      topKPerSource: maxPerSource
    });
  }

  /**
   * Legacy method for backward compatibility with Slack-only reranking
   */
  async rerankSlackMessages(
    query: string,
    messages: any[],
    topK: number = 20
  ): Promise<Array<{ index: number; score: number }>> {
    if (!this.apiKey || messages.length === 0) {
      return messages.map((_, i) => ({ index: i, score: 0 }));
    }

    try {
      const documents = messages.map(
        (msg) =>
          `Message: ${msg.text}\nFrom: ${
            msg.author || msg.user_id
          }\nChannel: #${msg.channel_name}`
      );

      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-Client-Name": "slack-search",
        },
        body: JSON.stringify({
          model: "rerank-v3.5",
          query: query,
          top_n: topK,
          documents: documents,
        }),
      });

      if (!response.ok) {
        console.error("Cohere rerank failed:", response.statusText);
        return messages.map((_, i) => ({ index: i, score: 0 }));
      }

      const data = await response.json();
      return data.results.map((r: any) => ({
        index: r.index,
        score: r.relevance_score,
      }));
    } catch (error) {
      console.error("Rerank error:", error);
      return messages.map((_, i) => ({ index: i, score: 0 }));
    }
  }

  /**
   * Format search results for optimal reranking
   */
  private formatResultForReranking(result: SearchResult): string {
    if (result.source === 'slack') {
      return `Message: ${result.content}\nFrom: ${result.metadata.user_name || 'Unknown'}\nChannel: #${result.metadata.channel_name || 'unknown'}`;
    } else {
      // Document formatting
      const parts = [`Content: ${result.content}`];
      
      if (result.metadata.document_title) {
        parts.unshift(`Document: ${result.metadata.document_title}`);
      }
      
      if (result.metadata.section_title && result.metadata.section_title !== 'Document Summary') {
        parts.splice(1, 0, `Section: ${result.metadata.section_title}`);
      }
      
      if (result.metadata.chunk_type) {
        parts.push(`Type: ${result.metadata.chunk_type}`);
      }
      
      return parts.join('\n');
    }
  }

  /**
   * Classify query to determine optimal search strategy
   */
  private classifyQuery(query: string): {
    isImplementationQuestion: boolean;
    isDiscussionQuestion: boolean;
    isTemporalQuery: boolean;
    isBroadTopic: boolean;
    isCodeRelated: boolean;
  } {
    const queryLower = query.toLowerCase();
    
    return {
      isImplementationQuestion: /\b(how to|implement|build|create|setup|configure|install|code|function|class|method)\b/.test(queryLower),
      isDiscussionQuestion: /\b(discuss|conversation|talk|said|mentioned|decided|opinion|think|feel|agree|disagree)\b/.test(queryLower),
      isTemporalQuery: /\b(yesterday|today|last week|recently|when|latest|recent|now|current)\b/.test(queryLower),
      isBroadTopic: /\b(tell me about|what is|explain|overview|summary|introduction)\b/.test(queryLower),
      isCodeRelated: /\b(bug|error|fix|debug|test|api|database|function|variable|class)\b/.test(queryLower)
    };
  }
}

export const cohereReranker = new CohereReranker();
