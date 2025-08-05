import OpenAI from 'openai';

export class EmbeddingService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw new Error(`Failed to generate embedding: ${error}`);
    }
  }

  async generateMultipleEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,
      });

      return response.data.map(item => item.embedding);
    } catch (error) {
      console.error('Error generating multiple embeddings:', error);
      throw new Error(`Failed to generate embeddings: ${error}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // In production, just check if we have an API key
      // In development, make an actual API call
      if (process.env.NODE_ENV === 'production') {
        return !!process.env.OPENAI_API_KEY;
      } else {
        // Test with a simple embedding request in development
        await this.generateEmbedding('test');
        return true;
      }
    } catch (error) {
      console.error('OpenAI health check failed:', error);
      return false;
    }
  }
}

export const embeddingService = new EmbeddingService();